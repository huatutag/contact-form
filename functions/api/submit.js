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
            // 可以记录 turnstileOutcome['error-codes'] 来帮助调试
            return new Response(JSON.stringify({ success: false, message: `人机验证失败。 ${turnstileOutcome['error-codes'] ? '错误: ' + turnstileOutcome['error-codes'].join(', ') : ''}`.trim() }), {
                status: 403, headers: { 'Content-Type': 'application/json' },
            });
        }

        // 可选: 验证 Turnstile action (如果前端设置了 data-action)
        // const expectedAction = 'contact_form_advanced_challenge'; // 假设前端 data-action 设置为此
        // if (turnstileOutcome.action && turnstileOutcome.action !== expectedAction) {
        //     console.log(`Turnstile action mismatch: expected ${expectedAction}, got ${turnstileOutcome.action}`);
        //     return new Response(JSON.stringify({ success: false, message: '人机验证操作不匹配。' }), {
        //         status: 403, headers: { 'Content-Type': 'application/json' },
        //     });
        // }


        // 2. 输入验证 (在Turnstile验证通过后)
        if (messageContent === null || messageContent === undefined || typeof messageContent !== 'string') {
            return new Response(JSON.stringify({ success: false, message: '消息内容不能为空且必须为文本。' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        const trimmedMessageContent = messageContent.trim(); // 去除首尾空格后再校验长度

        const MIN_MESSAGE_LENGTH = 5; // 示例：最小消息长度
        const MAX_MESSAGE_LENGTH = 500; // 示例：最大消息长度

        if (trimmedMessageContent.length < MIN_MESSAGE_LENGTH) {
            return new Response(JSON.stringify({ success: false, message: `消息内容过短，至少需要 ${MIN_MESSAGE_LENGTH} 个有效字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        if (messageContent.length > MAX_MESSAGE_LENGTH) { // 原始长度检查，防止超长字符串处理
            return new Response(JSON.stringify({ success: false, message: `消息内容过长，不能超过 ${MAX_MESSAGE_LENGTH} 个字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        // （可选）非常基础的HTML标签移除。
        // 这可以作为一层额外的防护，减少存储内容中的HTML，但不能完全替代XSS防护。
        // 真正的XSS防护核心在于数据展示时进行HTML转义。
        // 注意: 复杂的HTML清理需要更健壮的库，在Workers环境中可能需要谨慎选择。
        let contentToStore = messageContent.replace(/<[^>]*>/g, "").trim(); // 移除所有HTML标签并再次trim
        // 如果启用上面的清理，下面的 contentToStore 应该用这个变量，title也应基于清理后的内容生成
        // let contentToStore = messageContent; // 如果不进行服务器端清理，则直接使用原始消息

        // 检查D1数据库是否已绑定
        if (!env.DB) {
            console.error("D1 Database (DB) is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (D1_BIND)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

        // 使用清理后的内容（如果进行了清理）或原始内容生成title
        const title = contentToStore.substring(0, 60);
        const receivedAt = new Date().toISOString();

        try {
            const stmt = env.DB.prepare(
                'INSERT INTO messages (title, content, received_at) VALUES (?, ?, ?)'
            );
            // 确保这里使用的是最终要存入数据库的 contentToStore
            const result = await stmt.bind(title, contentToStore, receivedAt).run();

            if (result.success) {
                 return new Response(JSON.stringify({
                    success: true,
                    message: '消息已成功提交！', // 更新了成功消息
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
        console.error('Error processing POST request:', error);
        let errorMessage = '处理请求时发生内部错误。';
        if (error instanceof SyntaxError && error.message.includes("JSON")) {
            errorMessage = '请求体不是有效的JSON格式。';
        } else if (error.type === 'บัตรผ่าน') { // 捕捉 fetch 错误 (例如网络问题)
            console.error('Fetch error (e.g., network issue with Turnstile or D1):', error);
            errorMessage = '与服务器通信时发生网络错误，请稍后重试。';
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