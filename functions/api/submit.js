// functions/api/submit.js

// 用于生成唯一 ID
function generateUUID() {
    return crypto.randomUUID();
}

export async function onRequestPost(context) {
    try {
        const { request, env } = context; // env 用于访问环境变量和 KV Namespace
        const body = await request.json();

        const messageContent = body.message; // 注意变量名，避免与全局 message 冲突
        const token = body['cf-turnstile-response'];
        const ip = request.headers.get('CF-Connecting-IP');

        // 1. 验证 Turnstile Token
        const TURNSTILE_SECRET_KEY = env.TURNSTILE_SECRET_KEY;
        if (!TURNSTILE_SECRET_KEY) {
            console.error("TURNSTILE_SECRET_KEY is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误，无法验证请求 (T_SK)。' }), {
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
            return new Response(JSON.stringify({ success: false, message: '人机验证失败，请重试。' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 2. Turnstile 验证通过，准备数据存入 KV
        if (!messageContent || typeof messageContent !== 'string') {
            return new Response(JSON.stringify({ success: false, message: '消息内容不能为空。' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 检查 KV Namespace 是否已绑定
        if (!env.MESSAGES_KV) {
            console.error("MESSAGES_KV namespace is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误，无法存储消息 (KV_BIND)。' }), {
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

        // 生成一个唯一的 key 来存储消息
        const messageId = generateUUID();

        // 将消息对象转换为 JSON 字符串存入 KV
        await env.MESSAGES_KV.put(messageId, JSON.stringify(messageData));

        return new Response(JSON.stringify({ success: true, message: '消息已成功接收并存储！', messageId: messageId }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error processing POST request:', error);
        // 避免在生产环境中暴露详细的错误信息给客户端
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

// 如果 /api/submit 路径不需要 GET 方法，可以移除或返回一个提示
export async function onRequestGet(context) {
    return new Response("此接口用于提交消息 (POST)，获取消息请使用 GET /api/message。", {
        status: 405, // Method Not Allowed
        headers: { 'Allow': 'POST' }
    });
}