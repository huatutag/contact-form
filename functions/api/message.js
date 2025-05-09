// functions/api/message.js

export async function onRequestGet(context) {
    try {
        const { request, env } = context;

        // 1. API Key 验证
        const GET_MESSAGES_API_KEY = env.GET_MESSAGES_API_KEY;
        if (!GET_MESSAGES_API_KEY) {
            console.error("GET_MESSAGES_API_KEY is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误，无法验证请求 (K_ENV)。' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const url = new URL(request.url);
        const apiKeyFromRequest = url.searchParams.get('key'); // 从查询参数获取 key

        if (!apiKeyFromRequest) {
            return new Response(JSON.stringify({ success: false, message: '请求缺少 API Key。' }), {
                status: 400, // Bad Request
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (apiKeyFromRequest !== GET_MESSAGES_API_KEY) {
            return new Response(JSON.stringify({ success: false, message: '无效的 API Key。' }), {
                status: 401, // Unauthorized
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 2. 检查 KV Namespace 是否已绑定
        if (!env.MESSAGES_KV) {
            console.error("MESSAGES_KV namespace is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误，无法获取消息 (KV_BIND)。' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 3. 列出 KV 中的所有 key
        const listResult = await env.MESSAGES_KV.list();
        const keys = listResult.keys;

        if (!keys || keys.length === 0) {
            return new Response(JSON.stringify({ success: true, message: '当前没有可用的消息。', data: null }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 4. 随机选择一个 key
        const randomIndex = Math.floor(Math.random() * keys.length);
        const randomKeyInfo = keys[randomIndex];
        const keyNameToProcess = randomKeyInfo.name;

        // 5. 根据随机选中的 key 的 name 获取其 value
        const messageString = await env.MESSAGES_KV.get(keyNameToProcess);

        if (messageString === null) {
            // 这种情况可能发生在并发删除或者 key 列表与实际存储不一致的罕见情况
            console.warn(`Value for key '${keyNameToProcess}' was null, attempting to delete if it still exists and trying again or reporting.`);
            // 尝试删除，即使它是 null，以防万一
            await env.MESSAGES_KV.delete(keyNameToProcess);
            return new Response(JSON.stringify({ success: false, message: '无法检索到随机选择的消息内容，可能已被处理。请重试。' }), {
                status: 404, // Not Found or could be 500 if considered an inconsistency
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 6. 从 KV 中删除该消息
        // 确保在返回给客户端之前删除，以实现“获取后即移除”
        await env.MESSAGES_KV.delete(keyNameToProcess);

        // 7. 将获取到的 JSON 字符串转换回对象
        const messageObject = JSON.parse(messageString); // 假设 messageString 一定是有效的 JSON

        return new Response(JSON.stringify({ success: true, data: messageObject }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error processing GET request for random message:', error);
        let errorMessage = '获取消息时发生内部错误。';
        let errorStatus = 500;

        if (error instanceof SyntaxError && error.message.includes("JSON")) {
            errorMessage = '存储的数据格式无效。'; // 如果JSON.parse失败
        }
        // 你可以根据 error.name 或 error.message 来细化错误处理

        return new Response(JSON.stringify({ success: false, message: errorMessage }), {
            status: errorStatus,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

// 其他 HTTP 方法的处理保持不变
export async function onRequestPost(context) {
    return new Response("此接口用于获取消息 (GET)，提交消息请使用 POST /api/submit。", {
        status: 405, // Method Not Allowed
        headers: { 'Allow': 'GET' }
    });
}
// ... 其他方法 (PUT, DELETE, etc.)
