// functions/api/submit.js

export async function onRequestPost(context) {
    try {
        const { request, env } = context;
        const body = await request.json();

        let messageContent = body.message;
        const token = body['cf-turnstile-response'];
        const ip = request.headers.get('CF-Connecting-IP');

        // 1. 验证 Turnstile Token
        const TURNSTILE_SECRET_KEY = env.TURNSTILE_SECRET_KEY;
        if (!TURNSTILE_SECRET_KEY) {
            console.error("TURNSTILE_SECRET_KEY is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (T_SK)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

        let formData = new FormData();
        formData.append('secret', TURNSTILE_SECRET_KEY);
        formData.append('response', token);
        if (ip) {
            formData.append('remoteip', ip);
        }

        const turnstileUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        const turnstileResult = await fetch(turnstileUrl, {
            body: formData,
            method: 'POST',
        });
        const turnstileOutcome = await turnstileResult.json();

        if (!turnstileOutcome.success) {
            console.log('Turnstile verification failed:', turnstileOutcome);
            return new Response(JSON.stringify({ success: false, message: `人机验证失败。 ${turnstileOutcome['error-codes'] ? '错误: ' + turnstileOutcome['error-codes'].join(', ') : ''}`.trim() }), {
                status: 403, headers: { 'Content-Type': 'application/json' },
            });
        }

        // 2. 输入验证 (在Turnstile验证通过后)
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

        if (messageContent.length > MAX_MESSAGE_LENGTH) { // 原始长度检查
            return new Response(JSON.stringify({ success: false, message: `消息内容过长，不能超过 ${MAX_MESSAGE_LENGTH} 个字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        // 3. 敏感词检查 (使用去除首尾空格后的消息内容)
        const sensitiveWordCheckApiUrl = `https://v.api.aa1.cn/api/api-mgc/index.php?msg=${encodeURIComponent(trimmedMessageContent)}`;
        try {
            const sensitiveWordResponse = await fetch(sensitiveWordCheckApiUrl);
            if (sensitiveWordResponse.ok) {
                const sensitiveWordResult = await sensitiveWordResponse.json();
                // API 响应: {"code":200,"num":"1","desc":"存在敏感词","ci":"色情"} (num为1代表检测到敏感词)
                if (sensitiveWordResult && sensitiveWordResult.code === 200 && sensitiveWordResult.num === "1") {
                    console.log(`Sensitive word detected: Desc="${sensitiveWordResult.desc}", Category="${sensitiveWordResult.ci}". Message snippet: "${trimmedMessageContent.substring(0, 50)}..."`);
                    return new Response(JSON.stringify({
                        success: false,
                        message: `消息中包含敏感词 (${sensitiveWordResult.desc || '内容不当'})，已被拦截。`
                    }), {
                        status: 403, // Forbidden
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                console.log('Sensitive word check API call successful, no sensitive words detected or non-blocking response. Proceeding.');
            } else {
                // API 请求本身失败了 (e.g., 404, 500 from API server)
                console.warn(`Sensitive word check API request failed with status: ${sensitiveWordResponse.status}. Message will be processed as if no sensitive words were found.`);
            }
        } catch (apiError) {
            // fetch 自身的错误 (e.g., network error, DNS resolution failure)
            console.error('Error calling sensitive word check API (network or other fetch error):', apiError.message, '. Message will be processed as if no sensitive words were found.');
        }

        // 4. （可选）HTML标签移除与内容准备
        // 使用 trimmedMessageContent 进行清理，然后再次 trim
        let contentToStore = trimmedMessageContent.replace(/<[^>]*>/g, "").trim();

        // 如果清理后内容为空，但原始非空，则设置为一个空格，防止title生成等后续操作出错
        if (contentToStore.length === 0 && trimmedMessageContent.length > 0) {
            console.log("Content became empty after HTML sanitization, was originally non-empty. Setting to a single space.");
            contentToStore = " ";
        }
        // （可选）如果清理后内容过短，可以考虑是否拒绝。当前逻辑下，如果原始长度合格，清理后过短也会继续。
        // if (contentToStore.length < MIN_MESSAGE_LENGTH && trimmedMessageContent.length >= MIN_MESSAGE_LENGTH) {
        //     console.warn(`Content became too short after HTML sanitization. Original length: ${trimmedMessageContent.length}, Sanitized length: ${contentToStore.length}`);
        // }


        // 5. 数据库操作
        if (!env.DB) {
            console.error("D1 Database (DB) is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (D1_BIND)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

        const title = contentToStore.substring(0, 60); // Title基于清理后的内容
        const receivedAt = new Date().toISOString();

        try {
            const stmt = env.DB.prepare(
                'INSERT INTO messages (title, content, received_at) VALUES (?, ?, ?)'
            );
            const result = await stmt.bind(title, contentToStore, receivedAt).run();

            if (result.success) {
                 return new Response(JSON.stringify({
                    success: true,
                    message: '消息已成功提交！',
                    messageId: result.meta.last_row_id
                }), {
                    status: 201, // 201 Created
                    headers: { 'Content-Type': 'application/json' },
                });
            } else {
                console.error('D1 Insert failed:', result.error);
                return new Response(JSON.stringify({ success: false, message: '存储消息到数据库失败。' }), {
                    status: 500, headers: { 'Content-Type': 'application/json' },
                });
            }
        } catch (dbError) {
            console.error('D1 Database error during insert:', dbError);
            return new Response(JSON.stringify({ success: false, message: '数据库操作错误。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

    } catch (error) {
        console.error('Error processing POST request:', error.message, error.cause ? error.cause : '');
        let errorMessage = '处理请求时发生内部错误。';
        if (error instanceof SyntaxError && error.message.includes("JSON")) {
            errorMessage = '请求体不是有效的JSON格式。';
        } else if (error.name === 'FetchError' || (typeof error.message === 'string' && error.message.toLowerCase().includes('fetch'))) {
             console.error('Fetch error encountered (Turnstile, D1, or Sensitive Word API):', error.message, error.cause);
             errorMessage = '与依赖服务通信时发生网络错误，请稍后重试。';
        }
        return new Response(JSON.stringify({ success: false, message: errorMessage }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }
}

export async function onRequestGet(context) {
    // 保持不变，提示此端点仅用于POST
    return new Response("此接口用于提交消息 (POST)，获取消息请使用 GET /api/message。", {
        status: 405, headers: { 'Allow': 'POST' }
    });
}
