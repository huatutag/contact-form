// functions/api/submit.js

const RATE_LIMIT_DURATION_SECONDS = 3 * 60; // 3 分钟的秒数
const KV_KEY_PREFIX = "ip_submit_marker:"; // KV 键前缀，避免与其他键冲突

/**
 * Checks text for sensitive words using aizhan.com API.
 * @param {string} textToCheck The text to check.
 * @returns {Promise<object>} An object indicating the result:
 * - { sensitive: true, message: string, details: any[] } if sensitive words are found.
 * - { sensitive: false } if no sensitive words are found.
 * - { error: true, critical: boolean, message: string, details?: any } if an error occurred during the check.
 * 'critical' indicates if the main process should halt (or in this adjusted version, trigger a warning and prefix).
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
        if (!env.EMAIL_API_URL) {
            console.error("EMAIL_API_URL is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (E_URL)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (!env.EMAIL_API_KEY) {
            console.error("EMAIL_API_KEY is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (E_KEY)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

        // 1. 验证 Turnstile Token
        let turnstileFormData = new FormData();
        turnstileFormData.append('secret', env.TURNSTILE_SECRET_KEY);
        turnstileFormData.append('response', token);
        turnstileFormData.append('remoteip', ip);

        const turnstileUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        const turnstileResult = await fetch(turnstileUrl, {
            body: turnstileFormData,
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

        // 2. IP 防刷检查
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
                    status: 429,
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
        const MAX_MESSAGE_LENGTH = 500;

        if (trimmedMessageContent.length < MIN_MESSAGE_LENGTH) {
            return new Response(JSON.stringify({ success: false, message: `消息内容过短，至少需要 ${MIN_MESSAGE_LENGTH} 个有效字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (messageContent.length > MAX_MESSAGE_LENGTH) {
            return new Response(JSON.stringify({ success: false, message: `消息内容过长，不能超过 ${MAX_MESSAGE_LENGTH} 个字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        let contentToStore = messageContent.replace(/<[^>]*>/g, "").trim();
        if (contentToStore.length < MIN_MESSAGE_LENGTH) {
             return new Response(JSON.stringify({ success: false, message: `移除HTML标签后消息内容过短，至少需要 ${MIN_MESSAGE_LENGTH} 个有效字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        // 4. 敏感词检查 (使用新的爱站网API)
        console.log(`Performing sensitive word check for IP ${ip} with Aizhan API for content (first 50 chars): "${contentToStore.substring(0, 50)}..."`);
        const sensitiveCheckResult = await checkSensitiveWordsAizhan(contentToStore);

        let effectiveContentForEmail = contentToStore;
        let aizhanApiErrorOccurred = false;
        const aizhanApiErrorPrefix = "【爱站网敏感词API异常】";

        if (sensitiveCheckResult.sensitive) {
            // 检测到敏感词
            console.log(`Aizhan API detected sensitive words for IP ${ip}: ${sensitiveCheckResult.message}`);
            return new Response(JSON.stringify({
                success: false,
                message: sensitiveCheckResult.message
            }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        } else if (sensitiveCheckResult.error && sensitiveCheckResult.critical) {
            // API 调用本身失败 (网络问题, CSRF/Cookie 获取失败等)
            // 按要求：API异常时，仍然发送邮件，但在标题和内容前加上前缀
            console.warn(`Critical Aizhan API error for IP ${ip}: ${sensitiveCheckResult.message}. Proceeding with email sending, prefixing content. Details:`, sensitiveCheckResult.details || sensitiveCheckResult.cause || '');
            effectiveContentForEmail = `${aizhanApiErrorPrefix}${contentToStore}`;
            aizhanApiErrorOccurred = true;
            // 不在此处返回，继续执行邮件发送
        } else if (sensitiveCheckResult.error) { // Non-critical error
            console.warn(`Non-critical Aizhan API error for IP ${ip}: ${sensitiveCheckResult.message}. Proceeding as normal. Details:`, sensitiveCheckResult.details || sensitiveCheckResult.cause || '');
            // 根据需求，非严重错误目前不加前缀，正常发送。如果也需要加前缀，取消下一行的注释并调整逻辑。
            // effectiveContentForEmail = `${aizhanApiErrorPrefix}[非严重错误] ${contentToStore}`;
            // aizhanApiErrorOccurred = true; // 或者另一个标志来区分
        } else {
            console.log(`Aizhan API check passed for IP ${ip}. No sensitive words detected.`);
        }

        // 5. 发送邮件并通过第三方 API 及更新 IP 防刷记录
        try {
            await env.IP_RATE_LIMIT_KV.put(kvKey, Math.floor(Date.now() / 1000).toString(), {
                expirationTtl: RATE_LIMIT_DURATION_SECONDS
            });
            console.log(`IP ${ip} rate limit marker updated in KV. Expires in ${RATE_LIMIT_DURATION_SECONDS}s.`);

            const emailApiEndpoint = `${env.EMAIL_API_URL}?key=${env.EMAIL_API_KEY}`;
            const emailPayload = {
                // 如果您的邮件API支持标题和内容分离，您可能需要调整这里
                // 假设 email_content 同时作为标题和内容，或者API会从中提取标题
                email_content: effectiveContentForEmail // 使用经过处理的内容
            };

            console.log(`Attempting to send email for IP ${ip} via API: ${env.EMAIL_API_URL}. Prefixed: ${aizhanApiErrorOccurred}`);
            const emailResponse = await fetch(emailApiEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(emailPayload)
            });

            let successMessage = '消息已成功通过短信发送！';
            if (aizhanApiErrorOccurred) {
                successMessage = `${aizhanApiErrorPrefix}消息已发送，但敏感词检查时遇到问题。`;
            }

            if (emailResponse.ok) {
                let emailResponseData = {};
                try {
                    const contentType = emailResponse.headers.get("content-type");
                    if (contentType && contentType.indexOf("application/json") !== -1) {
                        emailResponseData = await emailResponse.json();
                    } else {
                        emailResponseData = {responseText: await emailResponse.text()};
                    }
                } catch (e) {
                    console.warn(`Could not parse JSON response from email API for IP ${ip}: ${e.message}. Status: ${emailResponse.status}`);
                    emailResponseData = { responseText: "Response was not valid JSON or was empty."};
                }

                console.log(`Email successfully sent for IP ${ip}. API Response:`, emailResponseData);
                return new Response(JSON.stringify({
                    success: true,
                    message: successMessage, // 使用调整后的成功消息
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            } else {
                const errorBodyText = await emailResponse.text();
                console.error(`Email API request failed for IP ${ip}: ${emailResponse.status} ${emailResponse.statusText}. Body: ${errorBodyText}`);
                // 即使邮件发送失败，如果是因为爱站网API异常导致的前缀，用户可能也想知道
                let failureMessage = `短信发送失败 (API错误: ${emailResponse.status})。请联系管理员。`;
                if (aizhanApiErrorOccurred) {
                     failureMessage = `${aizhanApiErrorPrefix}敏感词检查时遇到问题，且后续短信发送也失败 (API错误: ${emailResponse.status})。请联系管理员。`;
                }
                console.error(`Email error sent for IP ${ip}. API Response:`, errorBodyText);
                return new Response(JSON.stringify({
                    success: false,
                    message: failureMessage,
                }), {
                    status: 502,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        } catch (apiError) {
            console.error(`Error during email API call or KV update for IP ${ip}:`, apiError);
            let errorMessage = '发送短信或更新状态时发生内部错误。';
            let errorStatus = 500;
            if (apiError.type === 'บัตรผ่าน' || (apiError.cause && (apiError.cause.code === 'UND_ERR_CONNECT_TIMEOUT' || apiError.cause.code === 'ENOTFOUND'))) {
                errorMessage = `短信服务或内部存储连接超时，请稍后重试。 (${apiError.message})`;
                errorStatus = 504;
            }
            if (aizhanApiErrorOccurred) {
                 errorMessage = `${aizhanApiErrorPrefix}敏感词检查时遇到问题，且后续处理中发生错误：${errorMessage}`;
            }
            return new Response(JSON.stringify({ success: false, message: errorMessage }), {
                status: errorStatus, headers: { 'Content-Type': 'application/json' },
            });
        }

    } catch (error) {
        console.error('General error processing POST request:', error);
        let errorMessage = '处理请求时发生内部错误。';
        let errorStatus = 500;

        if (error instanceof SyntaxError && error.message.toLowerCase().includes("json")) {
            errorMessage = '请求体不是有效的JSON格式或为空。';
            errorStatus = 400;
        } else if (error.type === 'บัตรผ่าน' || (error.cause && (error.cause.code === 'UND_ERR_CONNECT_TIMEOUT' || error.cause.code === 'ENOTFOUND'))) {
            console.error('Outer fetch error (e.g., network issue with Turnstile):', error);
            errorMessage = '与外部验证服务通信时发生网络错误，请稍后重试。';
            errorStatus = 503;
        } else if (error.status) {
            errorStatus = error.status;
            if(error.message) errorMessage = error.message;
        }

        return new Response(JSON.stringify({ success: false, message: errorMessage }), {
            status: errorStatus, headers: { 'Content-Type': 'application/json' },
        });
    }
}

export async function onRequestGet(context) {
    return new Response("此接口用于提交消息 (POST)，获取消息请使用 GET /api/message。", {
        status: 405, headers: { 'Allow': 'POST' }
    });
}
