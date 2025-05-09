// Cloudflare Pages Functions 使用这种导出方式
// POST /api/submit
export async function onRequestPost(context) {
    try {
        const { request, env } = context; // env 用于访问环境变量
        const body = await request.json();

        const message = body.message; // 原始消息仍然从请求中获取
        const token = body['cf-turnstile-response']; // 从前端获取的 Turnstile token
        const ip = request.headers.get('CF-Connecting-IP'); // 获取用户 IP

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
                status: 403, // Forbidden
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 2. Turnstile 验证通过。
        // 原始消息内容检查仍然保留，即使它不直接发送到 /hello 接口
        if (!message || typeof message !== 'string') {
            return new Response(JSON.stringify({ success: false, message: '消息内容不能为空。' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 即使我们调用 /hello，也保留这些变量的定义，以防将来需要
        // 或者如果您希望基于 message 做一些其他操作。
        // const title = message.substring(0, 60);
        // const content = message;

        // 获取 Python 代理服务 /hello 接口的 URL
        // 你需要在 Cloudflare Pages 项目的设置 -> 环境变量中添加 PROXY_HELLO_URL
        // 例如 PROXY_HELLO_URL = "http://your-python-proxy-domain.com:5005/hello"
        const PROXY_HELLO_URL = env.PROXY_HELLO_URL;

        if (!PROXY_HELLO_URL) {
            console.error("PROXY_HELLO_URL is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误，目标接口地址未设置。' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        console.warn('=== 调用 Python 代理 /hello 接口 ===');
        console.warn('URL:', PROXY_HELLO_URL);

        // 调用 /hello 接口 (GET 请求，不需要 body 或特定头部)
        const proxyApiResponse = await fetch(PROXY_HELLO_URL, {
            method: 'GET', // /hello 接口是 GET 请求
            headers: {
                // 通常 /hello 接口不需要特定的认证头部，除非你的代理有额外设置
                // 'Accept': 'application/json', // 可以明确期望 JSON 返回
            }
        });

        console.warn('=== Python 代理 /hello 接口响应 ===');
        console.warn('Status:', proxyApiResponse.status);
        console.warn('Status Text:', proxyApiResponse.statusText);
        // console.warn('Headers:', Object.fromEntries(proxyApiResponse.headers.entries())); // 可选：打印响应头

        if (proxyApiResponse.ok) {
            const proxyResponseData = await proxyApiResponse.json(); // /hello 应该返回 {"message": "hello"}
            console.log('Response from /hello:', proxyResponseData);

            // 根据 /hello 的响应决定最终的成功消息
            // 例如，如果 proxyResponseData.message === "hello"，则认为成功
            if (proxyResponseData && proxyResponseData.message === "hello") {
                return new Response(JSON.stringify({ success: true, message: '与代理服务通信成功！收到了 "hello"。' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            } else {
                console.error('Unexpected response from /hello:', proxyResponseData);
                return new Response(JSON.stringify({ success: false, message: '代理服务返回了意外的响应。' }), {
                    status: 502, // Bad Gateway, or a more specific error if needed
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        } else {
            const errorText = await proxyApiResponse.text();
            console.error(`Error calling proxy /hello API (${proxyApiResponse.status}): ${errorText}`);
            return new Response(JSON.stringify({ success: false, message: `调用代理服务 ${PROXY_HELLO_URL} 失败 (状态: ${proxyApiResponse.status})。` }), {
                status: 502, // Bad Gateway
                headers: { 'Content-Type': 'application/json' },
            });
        }

    } catch (error) {
        console.error('Error processing request:', error);
        // 检查错误类型，如果是 fetch 导致的 TypeError (例如网络问题或 DNS 问题)
        if (error instanceof TypeError && error.message.includes('fetch')) {
             return new Response(JSON.stringify({ success: false, message: '网络错误，无法连接到目标服务。' }), {
                status: 503, // Service Unavailable or 504 Gateway Timeout
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(JSON.stringify({ success: false, message: '处理请求时发生内部错误。' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

// Cloudflare Pages Functions 也支持其他 HTTP 方法，如果需要的话
// onRequestGet 保持不变，或者您可以根据需要调整它
export async function onRequestGet(context) {
    // 可以返回一个简单的信息，或者这个函数提供的 API 描述
    return new Response(JSON.stringify({ info: "API endpoint. Use POST to submit data after Turnstile verification. The POST request now internally calls a /hello service." }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}
