// functions/api/submit.js

function generateUUID() {
    return crypto.randomUUID();
}

export async function onRequestPost(context) {
    try {
        const { request, env } = context;
        const body = await request.json();

        const messageContent = body.message;
        const token = body['cf-turnstile-response'];
        const ip = request.headers.get('CF-Connecting-IP');

        const TURNSTILE_SECRET_KEY = env.TURNSTILE_SECRET_KEY;
        if (!TURNSTILE_SECRET_KEY) {
            console.error("TURNSTILE_SECRET_KEY is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (T_SK)。' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

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
                status: 403,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (!messageContent || typeof messageContent !== 'string') {
            return new Response(JSON.stringify({ success: false, message: '消息内容不能为空。' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (!env.MESSAGES_KV) {
            console.error("MESSAGES_KV namespace is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (KV_BIND)。' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const title = messageContent.substring(0, 60);
        const content = messageContent;
        const receivedAt = new Date().toISOString();

        const messageData = {
            title: title,
            content: content,
            receivedAt: receivedAt,
        };

        const messageId = generateUUID();
        await env.MESSAGES_KV.put(messageId, JSON.stringify(messageData));

        return new Response(JSON.stringify({ success: true, message: '消息已成功存储！', messageId: messageId }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error processing POST request:', error);
        let errorMessage = '处理请求时发生内部错误。';
        if (error instanceof SyntaxError && error.message.includes("JSON")) {
            errorMessage = '请求体不是有效的 JSON 格式。';
        }
        return new Response(JSON.stringify({ success: false, message: errorMessage }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

export async function onRequestGet(context) {
    return new Response("此接口用于提交消息 (POST)，获取消息请使用 GET /api/message?apiKey=YOUR_API_KEY。", {
        status: 405,
        headers: { 'Allow': 'POST', 'Content-Type': 'application/json' }
    });
}
