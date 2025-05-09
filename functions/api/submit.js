// functions/api/submit.js

export async function onRequestPost(context) {
    try {
        const { request, env } = context;
        const body = await request.json();

        const messageContent = body.message;
        const token = body['cf-turnstile-response'];
        const ip = request.headers.get('CF-Connecting-IP');

        // 1. 验证 Turnstile Token (这部分逻辑不变)
        const TURNSTILE_SECRET_KEY = env.TURNSTILE_SECRET_KEY;
        if (!TURNSTILE_SECRET_KEY) {
            console.error("TURNSTILE_SECRET_KEY is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (T_SK)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }
        // ... (Turnstile 验证逻辑，与之前相同) ...
        let formData = new FormData();
        formData.append('secret', TURNSTILE_SECRET_KEY);
        formData.append('response', token);
        formData.append('remoteip', ip);

        const turnstileUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        const turnstileResult = await fetch(turnstileUrl, {
            body: formData,
            method: 'POST',
        });
        const turnstileOutcome = await turnstileResult.json();

        if (!turnstileOutcome.success) {
            console.log('Turnstile verification failed:', turnstileOutcome);
            return new Response(JSON.stringify({ success: false, message: '人机验证失败。' }), {
                status: 403, headers: { 'Content-Type': 'application/json' },
            });
        }

        // 2. Turnstile 验证通过，准备数据存入 D1
        if (!messageContent || typeof messageContent !== 'string') {
            return new Response(JSON.stringify({ success: false, message: '消息内容不能为空。' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        // 检查 D1 数据库是否已绑定
        if (!env.DB) {
            console.error("D1 Database (DB) is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (D1_BIND)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

        const title = messageContent.substring(0, 60);
        const content = messageContent;
        const receivedAt = new Date().toISOString();

        try {
            const stmt = env.DB.prepare(
                'INSERT INTO messages (title, content, received_at) VALUES (?, ?, ?)'
            );
            const result = await stmt.bind(title, content, receivedAt).run();

            // result.meta.last_row_id 包含新插入行的 ID (如果表有 AUTOINCREMENT 主键)
            // result.success 为 true 表示成功
            if (result.success) {
                 return new Response(JSON.stringify({
                    success: true,
                    message: '消息已成功存入数据库！',
                    messageId: result.meta.last_row_id // 返回新记录的 ID
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
        console.error('Error processing POST request:', error);
        let errorMessage = '处理请求时发生内部错误。';
        if (error instanceof SyntaxError && error.message.includes("JSON")) {
            errorMessage = '请求体不是有效的 JSON 格式。';
        }
        return new Response(JSON.stringify({ success: false, message: errorMessage }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }
}

// 如果 /api/submit 路径不需要 GET 方法，可以移除或返回一个提示
export async function onRequestGet(context) {
    return new Response("此接口用于提交消息 (POST)，获取消息请使用 GET /api/message。", {
        status: 405, headers: { 'Allow': 'POST' }
    });
}
