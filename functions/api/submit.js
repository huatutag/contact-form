export async function onRequestPost(context) {
    try {
        const { request, env } = context;
        const body = await request.json();

        const message = body.message;
        const token = body['cf-turnstile-response'];
        const ip = request.headers.get('CF-Connecting-IP');

        // 1. 验证 Turnstile Token
        const TURNSTILE_SECRET_KEY = env.TURNSTILE_SECRET_KEY;
        if (!TURNSTILE_SECRET_KEY) {
            console.error("TURNSTILE_SECRET_KEY is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误，无法验证请求。' }), {
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

        // 2. Turnstile 验证通过，发送到目标 API
        if (!message || typeof message !== 'string') {
            return new Response(JSON.stringify({ success: false, message: '消息内容不能为空。' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 准备请求 JSONPlaceholder API
        const targetApiUrl = 'https://jsonplaceholder.typicode.com/todos/1';

        // 打印请求内容
        console.warn('=== 外部 API 请求内容 ===');
        console.warn('URL:', targetApiUrl);
        console.warn('Method:', 'GET');
        console.warn('Headers:', {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; Cloudflare-Workers/1.0)',
        });

        const apiResponse = await fetch(targetApiUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (compatible; Cloudflare-Workers/1.0)',
            },
        });

        // 打印响应内容
        console.warn('=== 外部 API 响应内容 ===');
        console.warn('Status:', apiResponse.status);
        console.warn('Status Text:', apiResponse.statusText);
        console.warn('Headers:', Object.fromEntries(apiResponse.headers.entries()));

        let responseBody;
        try {
            responseBody = await apiResponse.json();
            console.warn('Body (JSON):', JSON.stringify(responseBody, null, 2));
        } catch (e) {
            responseBody = await apiResponse.text();
            console.warn('Body (Text):', responseBody);
        }

        if (apiResponse.ok) {
            return new Response(JSON.stringify({ success: true, message: '请求成功！', data: responseBody }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        } else {
            console.error(`Error calling external API (${apiResponse.status}): ${JSON.stringify(responseBody) || responseBody}`);
            return new Response(JSON.stringify({ success: false, message: `提交到目标服务 ${targetApiUrl} 失败 (状态: ${apiResponse.status})。` }), {
                status: 502,
                headers: { 'Content-Type': 'application/json' },
            });
        }

    } catch (error) {
        console.error('Error processing request:', error);
        return new Response(JSON.stringify({ success: false, message: '处理请求时发生内部错误。' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

export async function onRequestGet(context) {
    return new Response("API endpoint. Use POST to submit data.", { status: 200 });
}
