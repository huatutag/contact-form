// Cloudflare Pages Functions 使用这种导出方式
// POST /api/submit
export async function onRequestPost(context) {
    try {
        const { request, env } = context; // env 用于访问环境变量
        const body = await request.json();

        const message = body.message;
        const token = body['cf-turnstile-response']; // 从前端获取的 Turnstile token
        const ip = request.headers.get('CF-Connecting-IP'); // 获取用户 IP

        // 1. 验证 Turnstile Token
        // Cloudflare 会将 Turnstile Secret Key 注入到 env 对象中
        // 你需要在 Cloudflare Pages 项目的设置 -> 环境变量中添加 TURNSTILE_SECRET_KEY
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
                status: 403, // Forbidden
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 2. Turnstile 验证通过，准备并发送到你的目标 API
        if (!message || typeof message !== 'string') {
            return new Response(JSON.stringify({ success: false, message: '消息内容不能为空。' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const title = message.substring(0, 60);
        const content = message;

        // 从环境变量获取 API Key 和 Endpoint，更安全
        const EXTERNAL_API_KEY = env.EXTERNAL_API_KEY || "sUpErS3cr3tK3y!"; // 从环境变量读取，或使用默认值 (不推荐硬编码)
        const EXTERNAL_API_ENDPOINT = env.EXTERNAL_API_ENDPOINT || "http://47.108.147.164:5001/send"; // 从环境变量读取

        const targetApiUrl = `${EXTERNAL_API_ENDPOINT}?key=${EXTERNAL_API_KEY}`;

        const apiRequestBody = {
            title: title,
            content: content,
        };

        console.warn("娃哈哈");

        const apiResponse = await fetch(targetApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(apiRequestBody),
        });

        if (apiResponse.ok) {
            // 你可以根据需要检查 apiResponse.json() 的内容
            // const apiResponseData = await apiResponse.json(); (如果外部API返回JSON)
            return new Response(JSON.stringify({ success: true, message: '消息已成功发送！' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        } else {
            const errorText = await apiResponse.text();
            console.error(`Error calling external API (${apiResponse.status}): ${errorText}`);
            return new Response(JSON.stringify({ success: false, message: `提交到目标服务` + EXTERNAL_API_ENDPOINT + `失败 (状态: ${apiResponse.status})。` }), {
                status: 502, // Bad Gateway
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

// Cloudflare Pages Functions 也支持其他 HTTP 方法，如果需要的话
export async function onRequestGet(context) {
    return new Response("API endpoint. Use POST to submit data.", { status: 200 });
}