// functions/api/message.js

export async function onRequestGet(context) {
    try {
        const { request, env } = context;

        // 1. API Key 认证
        const GET_API_KEY = env.GET_MESSAGE_API_KEY;
        if (!GET_API_KEY) {
            console.error("GET_MESSAGE_API_KEY is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器端 API Key 未配置。' }), {
                status: 500, // Internal Server Error
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const url = new URL(request.url);
        const clientApiKey = url.searchParams.get('apiKey');

        if (!clientApiKey) {
            return new Response(JSON.stringify({ success: false, message: '未提供 API Key。' }), {
                status: 401, // Unauthorized
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (clientApiKey !== GET_API_KEY) {
            return new Response(JSON.stringify({ success: false, message: '无效的 API Key。' }), {
                status: 403, // Forbidden
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 2. 检查 KV Namespace 是否已绑定
        if (!env.MESSAGES_KV) {
            console.error("MESSAGES_KV namespace is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (KV_BIND)。' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 3. 使用 list({ limit: 1 }) 获取 KV 中的一个 key
        // 这将显著减少 list 操作的成本，因为它只读取一个 key 的元数据。
        const listResult = await env.MESSAGES_KV.list({ limit: 1 });

        if (!listResult.keys || listResult.keys.length === 0) {
            return new Response(JSON.stringify({ success: true, message: '当前没有可用的消息。', data: null }), {
                status: 200, // 或 404, 根据你的偏好
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const keyToFetch = listResult.keys[0].name; // 获取列表中的第一个 key 的名字

        // 4. 根据 key 获取其 value
        const messageString = await env.MESSAGES_KV.get(keyToFetch);

        if (messageString === null) {
            // 理论上，如果 list 返回了 key，get 不应该为 null，除非在极短时间内 key 被其他进程删除
            console.warn(`Value for key '${keyToFetch}' was null after listing. It might have been deleted concurrently.`);
            // 即使发生这种情况，我们也可以尝试再次 list，或者直接返回没有消息
            // 为简单起见，这里我们当作没有消息处理，或者可以尝试删除这个无效的key（如果确定它不该存在）
            await env.MESSAGES_KV.delete(keyToFetch); // 尝试清理
            return new Response(JSON.stringify({ success: true, message: '未能获取到消息内容，可能已被处理。请重试。', data: null }), {
                status: 200, // 或者特定的错误码
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 5. 将获取到的 JSON 字符串转换回对象
        const messageObject = JSON.parse(messageString);

        // 6. 从 KV 中删除该消息 (重要：确保在返回给客户端之前或之后可靠地删除)
        // 最好在确认消息可以被处理后再删除
        await env.MESSAGES_KV.delete(keyToFetch);

        return new Response(JSON.stringify({ success: true, data: messageObject }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error processing GET request for random message:', error);
        // 避免暴露详细错误给客户端
        let publicErrorMessage = '获取消息时发生内部错误。';
        if (error instanceof SyntaxError && error.message.includes("JSON")) {
             publicErrorMessage = '消息数据格式错误。';
        }
        return new Response(JSON.stringify({ success: false, message: publicErrorMessage }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

export async function onRequestPost(context) {
    return new Response("此接口用于获取消息 (GET)，并需要有效的 apiKey。提交消息请使用 POST /api/submit。", {
        status: 405,
        headers: { 'Allow': 'GET', 'Content-Type': 'application/json' }
    });
}