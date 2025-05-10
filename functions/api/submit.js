// functions/api/submit.js

const RATE_LIMIT_DURATION_SECONDS = 10 * 60; // 10 分钟的秒数
const KV_KEY_PREFIX = "ip_submit_marker:"; // KV 键前缀，避免与其他键冲突

/**
 * Checks text for sensitive words using aizhan.com API.
 * @param {string} textToCheck The text to check.
 * @returns {Promise<object>} An object indicating the result:
 * - { sensitive: true, message: string, details: any[] } if sensitive words are found.
 * - { sensitive: false } if no sensitive words are found.
 * - { error: true, critical: boolean, message: string, details?: any } if an error occurred during the check.
 * 'critical' indicates if the main process should halt.
 */
async function checkSensitiveWordsAizhan(textToCheck) {
    const initialUrl = 'https://tools.aizhan.com/forbidword/';
    const checkApiUrl = 'https://tools.aizhan.com/forbidword/check';
    const commonHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'sec-ch-ua': '"Chromium";v="136", "Microsoft Edge";v="136", "Not.A/Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
    };

    try {
        // --- Step 1: Fetch the initial page to get cookies and CSRF token ---
        const initResponse = await fetch(initialUrl, {
            headers: {
                ...commonHeaders,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Connection': 'keep-alive',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
            }
        });

        if (!initResponse.ok) {
            console.error(`Aizhan Init Fetch Error: ${initResponse.status} ${initResponse.statusText}. URL: ${initialUrl}`);
            return { error: true, critical: true, message: `敏感词服务暂时不可用 (获取令牌失败: ${initResponse.status})。请稍后重试。` };
        }

        const setCookieHeaders = initResponse.headers.getAll('Set-Cookie');
        const cookieString = setCookieHeaders.map(cookie => cookie.split(';')[0]).join('; ');
        const pageHtml = await initResponse.text();

        const csrfTokenRegex = /<input\s+type="hidden"\s+name="_csrf"\s+value="([^"]+)"/;
        let csrfMatch = pageHtml.match(csrfTokenRegex);
        if (!csrfMatch || !csrfMatch[1]) {
            // Fallback: try to find CSRF in meta tag
            const csrfMetaRegex = /<meta\s+name="csrf-token"\s+content="([^"]+)"/;
            csrfMatch = pageHtml.match(csrfMetaRegex);
        }

        if (!csrfMatch || !csrfMatch[1]) {
            console.error("Aizhan CSRF Token not found. HTML snippet (first 500 chars):", pageHtml.substring(0, 500));
            return { error: true, critical: true, message: '敏感词服务暂时不可用 (解析令牌失败)。请稍后重试。' };
        }
        const csrfToken = csrfMatch[1];

        if (!cookieString) {
            console.error('Aizhan Cookies not found after successful initial fetch.');
            return { error: true, critical: true, message: '敏感词服务暂时不可用 (获取会话失败)。请稍后重试。' };
        }

        // --- Step 2: Call the check API with cookies and CSRF token ---
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
                'Connection': 'keep-alive',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Cookie': cookieString,
                'Origin': 'https://tools.aizhan.com',
                'Referer': 'https://tools.aizhan.com/',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin',
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: formData.toString()
        });

        if (!checkResponse.ok) {
            const errorBody = await checkResponse.text();
            console.error(`Aizhan Check API Error: ${checkResponse.status} ${checkResponse.statusText}. URL: ${checkApiUrl}`, errorBody);
            return { error: true, critical: true, message: `敏感词检查服务失败 (${checkResponse.status})。请稍后重试。`, details: errorBody };
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
            return { sensitive: false }; // No sensitive words
        } else {
            console.error('Aizhan Check API unexpected JSON structure:', resultJson);
            return { error: true, critical: true, message: '敏感词服务响应异常。请稍后重试。', details: resultJson };
        }

    } catch (apiError) {
        console.error(`Aizhan API call failed entirely for text "${textToCheck.substring(0,50)}...":`, apiError);
        // Check for specific timeout errors from fetch
        if (apiError.type === 'บัตรผ่าน' || (apiError.cause && (apiError.cause.code === 'UND_ERR_CONNECT_TIMEOUT' || apiError.cause.code === 'UND_ERR_HEADERS_TIMEOUT'))) {
             return { error: true, critical: true, message: `敏感词服务连接超时，请稍后重试。(${apiError.message})`, cause: apiError };
        }
        return { error: true, critical: true, message: `敏感词服务请求失败 (${apiError.message})。请稍后重试。`, cause: apiError };
    }
}


export async function onRequestPost(context) {
    try {
        const { request, env } = context;
        const body = await request.json();

        let messageContent = body.message;
        const token = body['cf-turnstile-response'];
        const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || "unknown_ip";


        // 0. 检查必要的环境变量绑定
        if (!env.TURNSTILE_SECRET_KEY) {
            console.error("TURNSTILE_SECRET_KEY is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (T_SK)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (!env.IP_RATE_LIMIT_KV) {
            console.error("IP_RATE_LIMIT_KV (KV Namespace for IP Rate Limiting) is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (KV_BIND_RL)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (!env.DB) { // D1 数据库绑定检查移到实际使用前
            console.error("D1 Database (DB) is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (D1_BIND)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

        // 1. 验证 Turnstile Token
        let formData = new FormData();
        formData.append('secret', env.TURNSTILE_SECRET_KEY);
        formData.append('response', token);
        formData.append('remoteip', ip); // Always include IP

        const turnstileUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        const turnstileResult = await fetch(turnstileUrl, {
            body: formData,
            method: 'POST',
        });
        const turnstileOutcome = await turnstileResult.json();

        if (!turnstileOutcome.success) {
            console.log(`Turnstile verification failed for IP ${ip}:`, turnstileOutcome['error-codes']);
            return new Response(JSON.stringify({ success: false, message: `人机验证失败。 ${turnstileOutcome['error-codes'] ? '错误: ' + turnstileOutcome['error-codes'].join(', ') : ''}`.trim() }), {
                status: 403, headers: { 'Content-Type': 'application/json' },
            });
        }
        console.log(`Turnstile verification successful for IP ${ip}.`);

        // 2. IP 防刷检查 (Turnstile 通过后)
        const kvKey = `${KV_KEY_PREFIX}${ip}`;
        const lastSubmissionTimestampStr = await env.IP_RATE_LIMIT_KV.get(kvKey);

        if (lastSubmissionTimestampStr) {
            const lastSubmissionTimestamp = parseInt(lastSubmissionTimestampStr, 10);
            const currentTimeSeconds = Math.floor(Date.now() / 1000);
            const timeSinceLastSubmission = currentTimeSeconds - lastSubmissionTimestamp;

            if (timeSinceLastSubmission < RATE_LIMIT_DURATION_SECONDS) {
                const timeLeftSeconds = RATE_LIMIT_DURATION_SECONDS - timeSinceLastSubmission;
                const minutesLeft = Math.ceil(timeLeftSeconds / 60);
                console.log(`IP ${ip} is rate-limited. Time left: ${minutesLeft} minutes.`);
                return new Response(JSON.stringify({
                    success: false,
                    message: `当前ip操作过于频繁，请在 ${minutesLeft} 分钟后再试。`
                }), {
                    status: 429, // Too Many Requests
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }

        // 3. 输入验证
        if (messageContent === null || messageContent === undefined || typeof messageContent !== 'string') {
            return new Response(JSON.stringify({ success: false, message: '消息内容不能为空且必须为文本。' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        const trimmedMessageContent = messageContent.trim();
        const MIN_MESSAGE_LENGTH = 5;
        const MAX_MESSAGE_LENGTH = 500; // 保持您原有的长度限制

        if (trimmedMessageContent.length < MIN_MESSAGE_LENGTH) {
            return new Response(JSON.stringify({ success: false, message: `消息内容过短，至少需要 ${MIN_MESSAGE_LENGTH} 个有效字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (messageContent.length > MAX_MESSAGE_LENGTH) { // 检查原始长度，因为 trim 后的可能符合，但原始的过长
            return new Response(JSON.stringify({ success: false, message: `消息内容过长，不能超过 ${MAX_MESSAGE_LENGTH} 个字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        let contentToStore = messageContent.replace(/<[^>]*>/g, "").trim();
        if (contentToStore.length < MIN_MESSAGE_LENGTH) { // 再次检查处理后的内容
             return new Response(JSON.stringify({ success: false, message: `移除HTML标签后消息内容过短，至少需要 ${MIN_MESSAGE_LENGTH} 个有效字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }


        // 4. 敏感词检查 (使用新的爱站网API)
        console.log(`Performing sensitive word check for IP ${ip} with Aizhan API for content (first 50 chars): "${contentToStore.substring(0, 50)}..."`);
        const sensitiveCheckResult = await checkSensitiveWordsAizhan(contentToStore);

        if (sensitiveCheckResult.error && sensitiveCheckResult.critical) {
            // API 调用本身失败 (网络问题, CSRF/Cookie 获取失败等)
            console.error(`Critical Aizhan API error for IP ${ip}: ${sensitiveCheckResult.message}`, sensitiveCheckResult.details || sensitiveCheckResult.cause || '');
            return new Response(JSON.stringify({
                success: false,
                message: sensitiveCheckResult.message // 使用从函数返回的更具体的错误消息
            }), {
                status: 503, // Service Unavailable, as the dependency failed
                headers: { 'Content-Type': 'application/json' },
            });
        } else if (sensitiveCheckResult.sensitive) {
            // 检测到敏感词
            console.log(`Aizhan API detected sensitive words for IP ${ip}: ${sensitiveCheckResult.message}`);
            return new Response(JSON.stringify({
                success: false,
                message: sensitiveCheckResult.message
            }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }
        // 如果 sensitiveCheckResult.error 但 !sensitiveCheckResult.critical (如果未来添加这种逻辑)，可以记录警告并继续
        console.log(`Aizhan API check passed for IP ${ip}. No sensitive words detected or non-critical error.`);


        // 5. 存库操作与更新 IP 防刷记录
        const title = contentToStore.substring(0, 60); // 使用处理后的 contentToStore
        const receivedAt = new Date().toISOString();

        try {
            // 在真正执行数据库写入前，更新 KV 中的 IP 提交时间戳
            await env.IP_RATE_LIMIT_KV.put(kvKey, Math.floor(Date.now() / 1000).toString(), {
                expirationTtl: RATE_LIMIT_DURATION_SECONDS
            });
            console.log(`IP ${ip} rate limit marker updated in KV. Expires in ${RATE_LIMIT_DURATION_SECONDS}s.`);

            const stmt = env.DB.prepare(
                'INSERT INTO messages (title, content, received_at) VALUES (?, ?, ?)'
            );
            const dbResult = await stmt.bind(title, contentToStore, receivedAt).run();

            if (dbResult.success) {
                console.log(`Message from IP ${ip} successfully stored with ID: ${dbResult.meta.last_row_id}.`);
                return new Response(JSON.stringify({
                    success: true,
                    message: '消息已成功提交！',
                    messageId: dbResult.meta.last_row_id
                }), {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                });
            } else {
                console.error(`D1 Insert failed for IP ${ip}:`, dbResult.error);
                return new Response(JSON.stringify({ success: false, message: '存储消息到数据库失败。' }), {
                    status: 500, headers: { 'Content-Type': 'application/json' },
                });
            }
        } catch (dbError) {
            console.error(`D1 Database error during insert for IP ${ip}:`, dbError);
            return new Response(JSON.stringify({ success: false, message: '数据库操作错误。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

    } catch (error) {
        console.error('Error processing POST request:', error);
        let errorMessage = '处理请求时发生内部错误。';
        let errorStatus = 500;

        if (error instanceof SyntaxError && error.message.toLowerCase().includes("json")) {
            errorMessage = '请求体不是有效的JSON格式或为空。';
            errorStatus = 400;
        } else if (error.type === 'บัตรผ่าน' || (error.cause && (error.cause.code === 'UND_ERR_CONNECT_TIMEOUT' || error.cause.code === 'ENOTFOUND'))) {
            console.error('Fetch error (e.g., network issue with Turnstile or D1):', error);
            errorMessage = '与外部服务通信时发生网络错误，请稍后重试。';
            errorStatus = 503; // Service Unavailable
        }
        // 如果是自定义的错误对象，并且有 status 属性
        else if (error.status) {
            errorStatus = error.status;
            if(error.message) errorMessage = error.message;
        }


        return new Response(JSON.stringify({ success: false, message: errorMessage }), {
            status: errorStatus, headers: { 'Content-Type': 'application/json' },
        });
    }
}

export async function onRequestGet(context) {
    // 保持不变，提示此端点仅用于POST
    return new Response("此接口用于提交消息 (POST)，获取消息请使用 GET /api/message。", {
        status: 405, headers: { 'Allow': 'POST' }
    });
}