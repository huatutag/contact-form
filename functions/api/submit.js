// functions/api/submit.js

// --- 常量定义 ---
const RATE_LIMIT_DURATION_SECONDS = 3 * 60; // IP频率限制时长：3分钟（秒）
const KV_KEY_PREFIX_IP_LIMIT = "ip_submit_marker:"; // IP提交频率限制的KV键前缀
const KV_KEY_AIZHAN_COOKIE = "aizhan_cookie"; // 爱站Cookie的KV键名
const KV_KEY_AIZHAN_CSRF = "aizhan_csrf_token"; // 爱站CSRF令牌的KV键名
const AIZHAN_SESSION_CACHE_TTL_SECONDS = 30 * 60; // 爱站会话缓存有效期：30分钟（秒）

const EMAIL_SUBJECT_PREFIX = "[网站消息]"; // 邮件主题的统一前缀
const EMAIL_SUBJECT_SENSITIVE_CHECK_ERROR = `${EMAIL_SUBJECT_PREFIX} 敏感词检测服务异常`; // 敏感词检测错误的邮件主题
const EMAIL_SUBJECT_USER_SUBMISSION_ERROR = `${EMAIL_SUBJECT_PREFIX} 用户消息发送失败通知`; // 用户消息发送失败时给管理员的通知邮件主题
const EMAIL_SUBJECT_USER_SUBMISSION_SUCCESS = `${EMAIL_SUBJECT_PREFIX} 新的用户留言`; // 用户消息成功提交后的邮件主题（主要用于日志）


/**
 * 通用邮件发送函数
 * @param {object} env - Cloudflare Worker 的环境变量对象 (包含 EMAIL_API_URL, EMAIL_API_KEY)
 * @param {string} subject - 邮件主题 (主要用于日志，实际API可能只使用contentBody)
 * @param {string} contentBody - 邮件正文内容 (将作为 email_content 发送)
 * @param {boolean} [isCriticalNotification=false] - 是否为关键错误通知邮件。如果是，则发送失败时不应阻塞主流程。
 * @returns {Promise<object>} 返回一个包含发送结果的对象: { success: boolean, status?: number, responseData?: any, error?: string }
 */
async function sendEmail(env, subject, contentBody, isCriticalNotification = false) {
    if (!env.EMAIL_API_URL || !env.EMAIL_API_KEY) {
        console.error(`[邮件发送] 失败: EMAIL_API_URL 或 EMAIL_API_KEY 未配置。主题: ${subject}`);
        return { success: false, error: "邮件服务未配置" };
    }

    const emailApiEndpoint = `${env.EMAIL_API_URL}?key=${env.EMAIL_API_KEY}`;
    const emailPayload = {
        email_content: contentBody // 根据你的第三方邮件API调整，这里假设它接受一个 email_content 字段
    };

    try {
        console.log(`[邮件发送] 尝试发送邮件。主题: ${subject}`);
        const response = await fetch(emailApiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(emailPayload)
        });

        if (response.ok) {
            let responseData = {};
            try {
                const contentType = response.headers.get("content-type");
                if (contentType && contentType.includes("application/json")) {
                    responseData = await response.json();
                } else {
                    responseData = { responseText: await response.text() };
                }
            } catch (parseError) {
                console.warn(`[邮件发送] 解析邮件API响应JSON失败。主题: ${subject}，状态: ${response.status}，错误: ${parseError.message}`);
                responseData = { responseText: "响应非JSON或为空。" };
            }
            console.log(`[邮件发送] 成功。主题: ${subject}。API响应:`, responseData);
            return { success: true, status: response.status, responseData };
        } else {
            const errorBodyText = await response.text();
            console.error(`[邮件发送] 失败。主题: ${subject}。状态: ${response.status} ${response.statusText}。响应体: ${errorBodyText}`);
            return { success: false, status: response.status, error: errorBodyText };
        }
    } catch (exception) {
        console.error(`[邮件发送] 异常。主题: ${subject}。错误:`, exception);
        // 对于关键通知，即使这里失败了，也不要让它影响上层调用（例如，敏感词检测失败通知）
        // 但对于主要邮件发送（用户留言），上层需要知道这个失败。
        return { success: false, error: exception.message };
    }
}

/**
 * 使用爱站网API检查文本中的敏感词（带会话缓存）
 * @param {string} textToCheck 需要检查的文本
 * @param {object} env Cloudflare Worker 的环境变量对象 (用于KV存储和邮件通知)
 * @returns {Promise<object>} 返回一个包含检查结果的对象
 */
async function checkSensitiveWordsAizhan(textToCheck, env) {
    const initialUrl = 'https://tools.aizhan.com/forbidword/';
    const checkApiUrl = 'https://tools.aizhan.com/forbidword/check';
    const commonHeaders = { // 通用请求头
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0', // 请注意浏览器版本可能需要定期更新
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'sec-ch-ua': '"Chromium";v="136", "Microsoft Edge";v="136", "Not.A/Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
    };

    let cookieString = null;
    let csrfToken = null;

    // 步骤 1: 尝试从 KV 缓存中获取会话信息
    if (env.AIZHAN_SESSION_KV) {
        try {
            cookieString = await env.AIZHAN_SESSION_KV.get(KV_KEY_AIZHAN_COOKIE);
            csrfToken = await env.AIZHAN_SESSION_KV.get(KV_KEY_AIZHAN_CSRF);
        } catch (kvError) {
            console.error("[爱站敏感词] 从 AIZHAN_SESSION_KV 读取失败:", kvError);
            // 非致命错误，将继续尝试获取新的会话
        }
    } else {
        console.warn("[爱站敏感词] AIZHAN_SESSION_KV 未绑定。每次请求都将重新获取爱站会话。");
    }

    // 如果缓存中没有或已过期，则重新获取
    if (!cookieString || !csrfToken) {
        console.log("[爱站敏感词] 会话信息未在缓存中找到或已过期，正在获取新的会话...");
        try {
            // 请求爱站工具页面以获取 Cookie 和 CSRF Token
            const initResponse = await fetch(initialUrl, {
                headers: {
                    ...commonHeaders,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Connection': 'keep-alive', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1',
                }
            });

            if (!initResponse.ok) {
                const errorMsg = `敏感词服务暂时不可用 (获取令牌失败: ${initResponse.status})。请稍后重试。`;
                console.error(`[爱站敏感词] 初始化请求失败: ${initResponse.status} ${initResponse.statusText}. URL: ${initialUrl}`);
                const emailContent = `爱站初始化请求失败。\n状态码: ${initResponse.status}\nURL: ${initialUrl}\nStatusText: ${initResponse.statusText}`;
                await sendEmail(env, EMAIL_SUBJECT_SENSITIVE_CHECK_ERROR, emailContent, true);
                return { error: true, critical: true, message: errorMsg };
            }

            const setCookieHeaders = initResponse.headers.getAll('Set-Cookie');
            const freshCookieString = setCookieHeaders.map(cookie => cookie.split(';')[0]).join('; ');
            const pageHtml = await initResponse.text();

            const csrfTokenRegex = /<input\s+type="hidden"\s+name="_csrf"\s+value="([^"]+)"/;
            let csrfMatch = pageHtml.match(csrfTokenRegex);
            if (!csrfMatch || !csrfMatch[1]) { // 备用CSRF获取方式
                const csrfMetaRegex = /<meta\s+name="csrf-token"\s+content="([^"]+)"/;
                csrfMatch = pageHtml.match(csrfMetaRegex);
            }

            if (!csrfMatch || !csrfMatch[1]) {
                const errorMsg = '敏感词服务暂时不可用 (解析令牌失败)。请稍后重试。';
                console.error("[爱站敏感词] CSRF令牌未找到。HTML片段(前500字符):", pageHtml.substring(0, 500));
                const emailContent = `爱站CSRF令牌未找到。\nHTML (首500字符): ${pageHtml.substring(0, 500)}`;
                await sendEmail(env, EMAIL_SUBJECT_SENSITIVE_CHECK_ERROR, emailContent, true);
                return { error: true, critical: true, message: errorMsg };
            }
            const freshCsrfToken = csrfMatch[1];

            if (!freshCookieString) {
                const errorMsg = '敏感词服务暂时不可用 (获取会话失败)。请稍后重试。';
                console.error('[爱站敏感词] 初始化请求成功但未获取到Cookie。');
                await sendEmail(env, EMAIL_SUBJECT_SENSITIVE_CHECK_ERROR, "爱站Cookie未找到，尽管初始化请求成功。", true);
                return { error: true, critical: true, message: errorMsg };
            }

            cookieString = freshCookieString;
            csrfToken = freshCsrfToken;

            // 将新的会话信息存入KV
            if (env.AIZHAN_SESSION_KV) {
                try {
                    await env.AIZHAN_SESSION_KV.put(KV_KEY_AIZHAN_COOKIE, cookieString, { expirationTtl: AIZHAN_SESSION_CACHE_TTL_SECONDS });
                    await env.AIZHAN_SESSION_KV.put(KV_KEY_AIZHAN_CSRF, csrfToken, { expirationTtl: AIZHAN_SESSION_CACHE_TTL_SECONDS });
                    console.log("[爱站敏感词] 新的会话信息已缓存至KV。");
                } catch (kvPutError) {
                    console.error("[爱站敏感词] 写入会话信息到 AIZHAN_SESSION_KV 失败:", kvPutError);
                    const emailContent = `写入爱站会话到KV失败。\n错误: ${kvPutError.message}`;
                    await sendEmail(env, EMAIL_SUBJECT_SENSITIVE_CHECK_ERROR, emailContent, true);
                    // 非致命错误，当前请求仍可继续，但需记录
                }
            }
        } catch (initError) {
            console.error(`[爱站敏感词] 会话初始化抓取完全失败:`, initError);
            const errorMsg = `敏感词服务请求初始化失败 (${initError.message})。请稍后重试。`;
            const emailContent = `爱站会话抓取过程中发生异常。\n错误: ${initError.message}\nCause: ${initError.cause ? JSON.stringify(initError.cause) : 'N/A'}`;
            await sendEmail(env, EMAIL_SUBJECT_SENSITIVE_CHECK_ERROR, emailContent, true);
            return { error: true, critical: true, message: errorMsg, cause: initError };
        }
    } else {
        console.log("[爱站敏感词] 使用缓存的爱站会话信息。");
    }

    // 步骤 2: 使用获取到的会话信息调用敏感词检查API
    try {
        const formData = new URLSearchParams();
        formData.append('type', '1');
        formData.append('url', '');
        formData.append('word', textToCheck);
        formData.append('_csrf', csrfToken);

        const checkResponse = await fetch(checkApiUrl, {
            method: 'POST',
            headers: {
                ...commonHeaders,
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Connection': 'keep-alive', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Cookie': cookieString, 'Origin': 'https://tools.aizhan.com', 'Referer': initialUrl,
                'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: formData.toString()
        });

        if (!checkResponse.ok) {
            const errorBody = await checkResponse.text();
            const errorMsg = `敏感词检查服务失败 (${checkResponse.status})。请稍后重试。`;
            console.error(`[爱站敏感词] 检查API请求错误: ${checkResponse.status} ${checkResponse.statusText}. URL: ${checkApiUrl}`, errorBody);

            // 如果是认证类错误 (如403 Forbidden)，可能意味着缓存的会话失效了，清除它
            if ((checkResponse.status === 403 || checkResponse.status === 401) && env.AIZHAN_SESSION_KV) {
                console.log("[爱站敏感词] 检查API返回认证错误，清除缓存的会话。");
                await env.AIZHAN_SESSION_KV.delete(KV_KEY_AIZHAN_COOKIE);
                await env.AIZHAN_SESSION_KV.delete(KV_KEY_AIZHAN_CSRF);
            }
            const emailContent = `爱站检查API请求失败。\n状态码: ${checkResponse.status}\n响应体: ${errorBody}`;
            await sendEmail(env, EMAIL_SUBJECT_SENSITIVE_CHECK_ERROR, emailContent, true);
            return { error: true, critical: true, message: errorMsg, details: errorBody };
        }

        const resultJson = await checkResponse.json();

        if (resultJson.code === 200 && resultJson.data && Array.isArray(resultJson.data.sword_arr)) {
            if (resultJson.data.sword_arr.length > 0) {
                const detectedWordsInfo = resultJson.data.sword_arr.map(item => `${item.word} (${item.explain || '敏感内容'})`).join(', ');
                return {
                    sensitive: true,
                    message: `内容包含禁止词汇: ${detectedWordsInfo}。请修改后重试。`,
                    details: resultJson.data.sword_arr
                };
            }
            return { sensitive: false }; // 未检测到敏感词
        } else {
            console.error('[爱站敏感词] 检查API返回非预期的JSON结构:', resultJson);
            const errorMsg = '敏感词服务响应异常。请稍后重试。';
            const emailContent = `爱站检查API响应结构异常。\n响应: ${JSON.stringify(resultJson, null, 2)}`;
            await sendEmail(env, EMAIL_SUBJECT_SENSITIVE_CHECK_ERROR, emailContent, true);
            return { error: true, critical: true, message: errorMsg, details: resultJson };
        }

    } catch (apiError) {
        console.error(`[爱站敏感词] API调用完全失败。文本 (前50字符) "${textToCheck.substring(0, 50)}...":`, apiError);
        let errorMsg = `敏感词服务请求失败 (${apiError.message})。请稍后重试。`;
        // 特定的超时错误判断
        if (apiError.type === 'บัตรผ่าน' || (apiError.cause && (apiError.cause.code === 'UND_ERR_CONNECT_TIMEOUT' || apiError.cause.code === 'UND_ERR_HEADERS_TIMEOUT'))) {
            errorMsg = `敏感词服务连接超时，请稍后重试。(${apiError.message})`;
        }
        const emailContent = `爱站API调用完全失败。\n错误: ${apiError.message}\nCause: ${apiError.cause ? JSON.stringify(apiError.cause) : 'N/A'}`;
        await sendEmail(env, EMAIL_SUBJECT_SENSITIVE_CHECK_ERROR, emailContent, true);
        return { error: true, critical: true, message: errorMsg, cause: apiError };
    }
}

/**
 * 处理 POST 请求的主函数
 * @param {object} context - Cloudflare Worker 的上下文对象 (包含 request, env)
 */
export async function onRequestPost(context) {
    try {
        const { request, env } = context;
        const body = await request.json(); // 解析请求体为JSON

        const messageContent = body.message; // 用户提交的消息内容
        const turnstileToken = body['cf-turnstile-response']; // Turnstile 人机验证令牌
        // 获取客户端IP地址
        const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || "unknown_ip";

        // 步骤 0: 检查必要的环境变量和KV绑定是否已配置
        const requiredEnvVars = {
            "TURNSTILE_SECRET_KEY": "服务器配置错误 (T_SK)。",
            "IP_RATE_LIMIT_KV": "服务器配置错误 (KV_BIND_RL)。", // IP频率限制KV
            "AIZHAN_SESSION_KV": "服务器配置错误 (KV_BIND_AZ)。", // 爱站会话KV
            "EMAIL_API_URL": "服务器配置错误 (E_URL)。",      // 邮件API URL
            "EMAIL_API_KEY": "服务器配置错误 (E_KEY)。"       // 邮件API Key
        };

        for (const varName in requiredEnvVars) {
            if (!env[varName]) {
                console.error(`[配置检查] 环境变量或绑定 '${varName}' 未设置。`);
                return new Response(JSON.stringify({ success: false, message: requiredEnvVars[varName] }), {
                    status: 500, headers: { 'Content-Type': 'application/json' },
                });
            }
        }

        // 步骤 1: 验证 Turnstile Token (人机验证)
        let turnstileFormData = new FormData();
        turnstileFormData.append('secret', env.TURNSTILE_SECRET_KEY);
        turnstileFormData.append('response', turnstileToken);
        turnstileFormData.append('remoteip', ip); // 始终包含IP地址

        const turnstileUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        const turnstileResult = await fetch(turnstileUrl, { body: turnstileFormData, method: 'POST' });
        const turnstileOutcome = await turnstileResult.json();

        if (!turnstileOutcome.success) {
            console.log(`[Turnstile验证] 失败。IP: ${ip}，错误码:`, turnstileOutcome['error-codes']);
            const errorMsg = `人机验证失败。${turnstileOutcome['error-codes'] ? '错误: ' + turnstileOutcome['error-codes'].join(', ') : ''}`.trim();
            return new Response(JSON.stringify({ success: false, message: errorMsg }), {
                status: 403, headers: { 'Content-Type': 'application/json' }, // 403 Forbidden
            });
        }
        console.log(`[Turnstile验证] 成功。IP: ${ip}`);

        // 步骤 2: IP 提交频率限制检查 (通过Turnstile后)
        const kvKeyIpLimit = `${KV_KEY_PREFIX_IP_LIMIT}${ip}`;
        const lastSubmissionTimestampStr = await env.IP_RATE_LIMIT_KV.get(kvKeyIpLimit);

        if (lastSubmissionTimestampStr) {
            const lastSubmissionTimestamp = parseInt(lastSubmissionTimestampStr, 10);
            const currentTimeSeconds = Math.floor(Date.now() / 1000);
            const timeSinceLastSubmission = currentTimeSeconds - lastSubmissionTimestamp;

            if (timeSinceLastSubmission < RATE_LIMIT_DURATION_SECONDS) {
                const timeLeftSeconds = RATE_LIMIT_DURATION_SECONDS - timeSinceLastSubmission;
                const minutesLeft = Math.ceil(timeLeftSeconds / 60);
                console.log(`[IP频率限制] IP ${ip} 操作过于频繁，剩余 ${minutesLeft} 分钟。`);
                return new Response(JSON.stringify({
                    success: false,
                    message: `当前IP操作过于频繁，请在 ${minutesLeft} 分钟后再试。`
                }), {
                    status: 429, headers: { 'Content-Type': 'application/json' }, // 429 Too Many Requests
                });
            }
        }

        // 步骤 3: 输入内容验证
        if (messageContent === null || messageContent === undefined || typeof messageContent !== 'string') {
            return new Response(JSON.stringify({ success: false, message: '消息内容不能为空且必须为文本。' }), {
                status: 400, headers: { 'Content-Type': 'application/json' }, // 400 Bad Request
            });
        }

        const trimmedMessageContent = messageContent.trim(); // 去除首尾空格
        const MIN_MESSAGE_LENGTH = 5;    // 消息最小长度
        const MAX_MESSAGE_LENGTH = 500;  // 消息最大长度

        if (trimmedMessageContent.length < MIN_MESSAGE_LENGTH) {
            return new Response(JSON.stringify({ success: false, message: `消息内容过短，至少需要 ${MIN_MESSAGE_LENGTH} 个有效字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (messageContent.length > MAX_MESSAGE_LENGTH) { // 检查原始长度，因为trim后的可能符合，但原始的过长
            return new Response(JSON.stringify({ success: false, message: `消息内容过长，不能超过 ${MAX_MESSAGE_LENGTH} 个字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        // 移除HTML标签并再次修剪，然后进行长度检查
        let contentToStore = messageContent.replace(/<[^>]*>/g, "").trim();
        if (contentToStore.length < MIN_MESSAGE_LENGTH) {
            return new Response(JSON.stringify({ success: false, message: `移除HTML标签后消息内容过短，至少需要 ${MIN_MESSAGE_LENGTH} 个有效字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }
        // 确保处理后的内容也不超过限制
        if (contentToStore.length > MAX_MESSAGE_LENGTH) {
             contentToStore = contentToStore.substring(0, MAX_MESSAGE_LENGTH); // 超长则截断
        }

        // 步骤 4: 敏感词检查 (传入 env 对象)
        console.log(`[敏感词检查] IP: ${ip}，内容 (前50字符): "${contentToStore.substring(0, 50)}..."`);
        const sensitiveCheckResult = await checkSensitiveWordsAizhan(contentToStore, env);

        if (sensitiveCheckResult.error && sensitiveCheckResult.critical) {
            // 敏感词API调用本身发生严重错误 (如网络问题, CSRF/Cookie获取失败等)
            console.error(`[敏感词检查] 严重错误。IP: ${ip}，信息: ${sensitiveCheckResult.message}`, sensitiveCheckResult.details || sensitiveCheckResult.cause || '');
            // 错误邮件通知已在 checkSensitiveWordsAizhan 内部根据需要发送
            return new Response(JSON.stringify({
                success: false,
                message: sensitiveCheckResult.message // 使用从函数返回的更具体的错误消息
            }), {
                status: 503, headers: { 'Content-Type': 'application/json' }, // 503 Service Unavailable
            });
        } else if (sensitiveCheckResult.sensitive) {
            // 检测到敏感词
            console.log(`[敏感词检查] 检测到敏感词。IP: ${ip}，信息: ${sensitiveCheckResult.message}`);
            return new Response(JSON.stringify({
                success: false,
                message: sensitiveCheckResult.message
            }), {
                status: 400, headers: { 'Content-Type': 'application/json' }, // 400 Bad Request
            });
        }
        console.log(`[敏感词检查] 通过。IP: ${ip}。未检测到敏感词或发生非严重错误。`);

        // 步骤 5: 发送邮件并通过第三方 API，并更新 IP 防刷记录
        try {
            // 首先更新 KV 中的 IP 提交时间戳
            await env.IP_RATE_LIMIT_KV.put(kvKeyIpLimit, Math.floor(Date.now() / 1000).toString(), {
                expirationTtl: RATE_LIMIT_DURATION_SECONDS // 设置TTL与限制周期一致
            });
            console.log(`[IP频率限制] IP ${ip} 的提交标记已在KV中更新，有效期 ${RATE_LIMIT_DURATION_SECONDS} 秒。`);

            // 构建邮件内容并发送
            const userMessageEmailContent = `来自用户 (IP: ${ip}) 的新消息：\n\n${contentToStore}\n\n提交时间: ${new Date().toISOString()}`;
            const emailResult = await sendEmail(env, EMAIL_SUBJECT_USER_SUBMISSION_SUCCESS, userMessageEmailContent);

            if (emailResult.success) {
                console.log(`[邮件发送] 用户消息邮件成功发送。IP: ${ip}。API响应:`, emailResult.responseData);
                return new Response(JSON.stringify({
                    success: true,
                    message: '消息已成功通过邮件发送！',
                    apiResponse: emailResult.responseData // 可选：包含部分API响应给前端
                }), {
                    status: 200, headers: { 'Content-Type': 'application/json' }, // 200 OK
                });
            } else {
                // 主要邮件发送失败
                console.error(`[邮件发送] 用户消息邮件发送失败。IP: ${ip}，状态: ${emailResult.status}，错误: ${emailResult.error}`);
                // 尝试发送一个通知给管理员，告知主邮件发送失败
                const adminNotificationContent = `警告：尝试向用户 (IP: ${ip}) 发送消息 "${contentToStore.substring(0,100)}..." 的邮件未能成功。\n邮件API原始错误: ${emailResult.status || 'N/A'} - ${emailResult.error || 'N/A'}\n时间: ${new Date().toISOString()}`;
                await sendEmail(env, EMAIL_SUBJECT_USER_SUBMISSION_ERROR, adminNotificationContent, true); // isCriticalNotification = true

                return new Response(JSON.stringify({
                    success: false,
                    message: `邮件发送失败 (API错误: ${emailResult.status || '未知'})。请联系管理员。`,
                    details: emailResult.error
                }), {
                    status: 502, headers: { 'Content-Type': 'application/json' }, // 502 Bad Gateway
                });
            }
        } catch (finalStageError) { // 这个catch主要捕获KV操作错误或sendEmail之前的其他同步错误
            console.error(`[最终阶段处理] 错误。IP: ${ip}:`, finalStageError);
            let userMessage = '发送邮件或更新状态时发生内部错误。';
            let statusCode = 500;
            // 检查是否是fetch相关的超时或网络错误
            if (finalStageError.type === 'บัตรผ่าน' || (finalStageError.cause && (finalStageError.cause.code === 'UND_ERR_CONNECT_TIMEOUT' || finalStageError.cause.code === 'ENOTFOUND'))) {
                 userMessage = `邮件服务或内部存储连接超时，请稍后重试。 (${finalStageError.message})`;
                 statusCode = 504; // Gateway Timeout
            }
            // 发送管理员通知
            const adminErrorContent = `在最终处理阶段（发送邮件/更新KV）发生严重错误。\n用户IP: ${ip}\n错误信息: ${finalStageError.message}\nCause: ${finalStageError.cause ? JSON.stringify(finalStageError.cause) : 'N/A'}`;
            await sendEmail(env, EMAIL_SUBJECT_USER_SUBMISSION_ERROR, adminErrorContent, true);

            return new Response(JSON.stringify({ success: false, message: userMessage }), {
                status: statusCode, headers: { 'Content-Type': 'application/json' },
            });
        }

    } catch (error) { // 最外层 allgemeine (通用) 错误捕获
        console.error('[全局错误] 处理POST请求时发生错误:', error);
        let errorMessage = '处理请求时发生内部错误。';
        let errorStatus = 500;

        if (error instanceof SyntaxError && error.message.toLowerCase().includes("json")) {
            errorMessage = '请求体不是有效的JSON格式或为空。';
            errorStatus = 400;
        } else if (error.type === 'บัตรผ่าน' || (error.cause && (error.cause.code === 'UND_ERR_CONNECT_TIMEOUT' || error.cause.code === 'ENOTFOUND'))) {
            // 这通常是Turnstile验证的fetch错误，因为其他fetch有自己的try-catch
            console.error('[全局错误] 外部fetch错误 (例如，与Turnstile的网络问题):', error);
            errorMessage = '与外部验证服务通信时发生网络错误，请稍后重试。';
            errorStatus = 503; // Service Unavailable
        } else if (error.status) { // 如果错误对象有status属性 (不太可能到这里，因为多数fetch已处理)
            errorStatus = error.status;
            if(error.message) errorMessage = error.message;
        }

        // 对于最外层的未知错误，也可以考虑发送邮件通知，但需谨慎避免循环
        // await sendEmail(env, `${EMAIL_SUBJECT_PREFIX} 全局请求处理异常`, `捕获到未处理的全局异常: ${error.message}\nStack: ${error.stack}`, true);

        return new Response(JSON.stringify({ success: false, message: errorMessage }), {
            status: errorStatus, headers: { 'Content-Type': 'application/json' },
        });
    }
}

/**
 * 处理 GET 请求
 * @param {object} context - Cloudflare Worker 的上下文对象
 */
export async function onRequestGet(context) {
    // 返回405 Method Not Allowed，并提示允许POST方法
    return new Response("此接口用于提交消息 (POST)。", {
        status: 405, // Method Not Allowed
        headers: { 'Allow': 'POST' }
    });
}
