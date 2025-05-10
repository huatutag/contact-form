// functions/api/submit.js

export async function onRequestPost(context) {
    try {
        const { request, env } = context;
        const body = await request.json();

        let messageContent = body.message; // 使用let，因为可能会被清理后的内容替换
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
        if (ip) { // 确保ip存在时才添加
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

        if (messageContent.length > MAX_MESSAGE_LENGTH) {
            return new Response(JSON.stringify({ success: false, message: `消息内容过长，不能超过 ${MAX_MESSAGE_LENGTH} 个字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }
        
        // （可选）非常基础的HTML标签移除。
        let contentToStore = messageContent.replace(/<[^>]*>/g, "").trim();


        // 3. 敏感词检查 (在输入验证通过后，入库前)
        const sensitiveCheckApiUrl = `https://v.api.aa1.cn/api/api-mgc/index.php?msg=${encodeURIComponent(contentToStore)}`;
        try {
            const sensitiveCheckResponse = await fetch(sensitiveCheckApiUrl);
            if (sensitiveCheckResponse.ok) {
                const sensitiveCheckResult = await sensitiveCheckResponse.json();
                // {"code":200,"num":"1","desc":"存在敏感词","ci":"色情"}
                if (sensitiveCheckResult && sensitiveCheckResult.num === "1") {
                    console.log('Sensitive word detected:', sensitiveCheckResult);
                    return new Response(JSON.stringify({ success: false, message: `消息中包含敏感词 (${sensitiveCheckResult.desc || '详情未知'})，无法提交。` }), {
                        status: 400, headers: { 'Content-Type': 'application/json' },
                    });
                }
            } else {
                // API请求不成功 (例如 404, 500等)，按要求继续后续操作
                console.warn(`Sensitive word check API request failed with status: ${sensitiveCheckResponse.status}. Proceeding with submission.`);
            }
        } catch (apiError) {
            // API请求本身失败 (例如网络问题，DNS问题等)，按要求继续后续操作
            console.error('Sensitive word check API request failed:', apiError);
            // 在这种情况下，我们仍然继续进行存库操作
        }


        // 4. 存库操作
        if (!env.DB) {
            console.error("D1 Database (DB) is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (D1_BIND)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

        const title = contentToStore.substring(0, 60);
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
                    status: 201,
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
        console.error('Error processing POST request:', error);
        let errorMessage = '处理请求时发生内部错误。';
        if (error instanceof SyntaxError && error.message.includes("JSON")) {
            errorMessage = '请求体不是有效的JSON格式。';
        } else if (error.type === 'บัตรผ่าน' || (error.cause && error.cause.code === 'UND_ERR_CONNECT_TIMEOUT') || (error.cause && error.cause.code === 'ENOTFOUND') ) {
            console.error('Fetch error (e.g., network issue with Turnstile, Sensitive API or D1):', error);
            errorMessage = '与外部服务通信时发生网络错误，请稍后重试。';
        }
        return new Response(JSON.stringify({ success: false, message: errorMessage }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }
}

export async function onRequestGet(context) {
    return new Response("此接口用于提交消息 (POST)，获取消息请使用 GET /api/message。", {
        status: 405, headers: { 'Allow': 'POST' }
    });
}
