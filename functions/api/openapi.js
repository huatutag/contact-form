// functions/api/openapi.js

const MAX_MESSAGE_LENGTH = 500; // Maximum characters for the message
const MIN_MESSAGE_LENGTH = 1;   // Minimum characters for the message (after basic trim)

export async function onRequestPost(context) {
    try {
        const { request, env } = context;

        // 0. Check for necessary environment variables
        if (!env.EMAIL_API_URL) {
            console.error("EMAIL_API_URL is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (E_URL)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

        // 1. Extract API key from URL and message from body
        const requestUrl = new URL(request.url);
        const apiKey = requestUrl.searchParams.get('key');
        const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || "unknown_ip";


        if (!apiKey) {
            console.log(`API key missing in request from IP ${ip}`);
            return new Response(JSON.stringify({ success: false, message: 'API key ( ?key=... ) 未在URL参数中提供。' }), {
                status: 401, headers: { 'Content-Type': 'application/json' },
            });
        }

        let requestBody;
        try {
            requestBody = await request.json();
        } catch (e) {
            console.log(`Invalid JSON body from IP ${ip}: ${e.message}`);
            return new Response(JSON.stringify({ success: false, message: '请求体不是有效的JSON格式或为空。' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        const messageContent = requestBody.message;

        // 2. Input Validation
        if (messageContent === null || messageContent === undefined || typeof messageContent !== 'string') {
            return new Response(JSON.stringify({ success: false, message: '消息内容 (message) 不能为空且必须为文本。' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        const trimmedMessageContent = messageContent.trim();

        if (trimmedMessageContent.length < MIN_MESSAGE_LENGTH) {
            return new Response(JSON.stringify({ success: false, message: `消息内容过短，至少需要 ${MIN_MESSAGE_LENGTH} 个有效字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }
        // Check original length before stripping HTML, as stripping might reduce it significantly.
        // The email API itself will use the first 64 chars of the *final* content for the subject.
        if (messageContent.length > MAX_MESSAGE_LENGTH) {
            return new Response(JSON.stringify({ success: false, message: `消息内容过长，不能超过 ${MAX_MESSAGE_LENGTH} 个字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        // Basic HTML stripping and final trim for the content to be sent
        const emailBodyContent = messageContent.replace(/<[^>]*>/g, "").trim();

        // After stripping HTML, if the content becomes too short (e.g., only HTML tags were sent)
        if (emailBodyContent.length < MIN_MESSAGE_LENGTH) {
             return new Response(JSON.stringify({ success: false, message: `移除HTML标签后消息内容过短，至少需要 ${MIN_MESSAGE_LENGTH} 个有效字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }
        // No need to re-check MAX_MESSAGE_LENGTH on emailBodyContent, as the original messageContent was already checked.
        // The email API will handle subject generation from this emailBodyContent.

        // 3. Call Third-Party Email API
        const emailApiEndpoint = `${env.EMAIL_API_URL}?key=${apiKey}`; // Use apiKey from URL
        const emailPayload = {
            email_content: emailBodyContent
        };

        console.log(`Attempting to send email via personal API for IP ${ip}. Target: ${env.EMAIL_API_URL}`);
        try {
            const emailResponse = await fetch(emailApiEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(emailPayload)
            });

            if (emailResponse.ok) {
                let emailResponseData = {};
                try {
                     const contentType = emailResponse.headers.get("content-type");
                     if (contentType && contentType.indexOf("application/json") !== -1) {
                        emailResponseData = await emailResponse.json();
                     } else {
                        emailResponseData = {responseText: await emailResponse.text()}; // Fallback to text
                     }
                } catch (e) {
                    console.warn(`Could not parse JSON response from email API for IP ${ip}: ${e.message}. Status: ${emailResponse.status}`);
                    emailResponseData = { responseText: "Response was not valid JSON or was empty."};
                }

                console.log(`Email successfully sent for IP ${ip} via personal API. Response:`, emailResponseData);
                return new Response(JSON.stringify({
                    success: true,
                    message: '邮件已成功发送！',
                    apiResponse: emailResponseData
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            } else {
                const errorBodyText = await emailResponse.text();
                console.error(`Email API request failed for IP ${ip}: ${emailResponse.status} ${emailResponse.statusText}. Body: ${errorBodyText}`);
                return new Response(JSON.stringify({
                    success: false,
                    message: `邮件发送失败 (API错误: ${emailResponse.status})。请检查API Key或联系服务提供商。`,
                    details: errorBodyText
                }), {
                    status: emailResponse.status, // Propagate status from downstream API if appropriate
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        } catch (apiError) {
            console.error(`Error calling email API for IP ${ip}:`, apiError);
            if (apiError.type === 'บัตรผ่าน' || (apiError.cause && (apiError.cause.code === 'UND_ERR_CONNECT_TIMEOUT' || apiError.cause.code === 'ENOTFOUND'))) {
                 return new Response(JSON.stringify({ success: false, message: `邮件服务连接超时，请稍后重试。(${apiError.message})` }), {
                    status: 504, // Gateway Timeout
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ success: false, message: '调用邮件API时发生意外错误。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

    } catch (error) {
        // Catch errors from request.json() or other unexpected issues
        console.error('General error processing POST request in internal_email:', error);
        return new Response(JSON.stringify({ success: false, message: '处理请求时发生内部错误。' }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }
}

export async function onRequestGet(context) {
    // Provide a simple GET response indicating how to use the endpoint
    return new Response("此接口用于通过POST请求发送邮件。请在POST请求的JSON体中提供 'message' 字段，并在URL中通过 '?key=YOUR_API_KEY' 提供API密钥。", {
        status: 405, // Method Not Allowed
        headers: { 'Allow': 'POST', 'Content-Type': 'text/plain; charset=utf-8' }
    });
}

// Optional: Handle other methods if you want to be explicit
export async function onRequest(context) {
    if (context.request.method === "POST") {
        return onRequestPost(context);
    } else if (context.request.method === "GET") {
        return onRequestGet(context);
    }
    return new Response("方法不允许。", {
        status: 405,
        headers: { 'Allow': 'POST, GET' }
    });
}