// functions/api/message.js

export async function onRequestGet(context) {
    try {
        const { request, env } = context;
        const url = new URL(request.url);
        const clientApiKey = url.searchParams.get('apiKey');

        // 1. API Key 验证
        const SERVER_API_KEY = env.GET_API_KEY;
        if (!SERVER_API_KEY) {
            console.error("GET_API_KEY is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (API_KEY_MISSING)。' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (clientApiKey !== SERVER_API_KEY) {
            console.warn(`Invalid API key attempt: ${clientApiKey}`);
            return new Response(JSON.stringify({ success: false, message: '无效的 API Key。' }), {
                status: 401, // Unauthorized
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

        // 3. 列出 KV 中的所有 key
        // !! 成本警告 !!: list() 操作会计入KV的使用额度。
        // 免费套餐通常对 list() 操作有较低的每日限额 (例如 1000 次/天)。
        // 如果此接口调用频繁，可能会超出免费额度并产生费用。
        // 考虑优化策略：
        //  a) 如果可接受非随机（如“第一条”），使用 list({limit:1})。
        //  b) 监控使用量，如果接近限额，再实施更复杂的索引或随机抽样策略。
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
        const keyNameToFetch = randomKeyInfo.name;

        // 5. 根据随机选中的 key 的 name 获取其 value
        const messageString = await env.MESSAGES_KV.get(keyNameToFetch);

        if (messageString === null) {
            // 这种情况可能发生在：在 list() 和 get() 之间，该 key 被另一个并发请求删除了。
            // 或者 list() 返回的 key 因为某些原因在 get() 时已失效。
            console.warn(`Key ${keyNameToFetch} found in list but not retrievable from KV. Potentially deleted concurrently.`);
            // 可以选择重试，或者直接返回没有可用消息
            return new Response(JSON.stringify({ success: true, message: '尝试获取消息失败，可能已被处理，请重试。', data: null }), {
                status: 200, // 或 404 Not Found if you prefer
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 6. 将获取到的 JSON 字符串转换回对象
        const messageObject = JSON.parse(messageString);

        // 7. 从 KV 中删除该消息 (重要：确保在成功获取并解析后再删除)
        await env.MESSAGES_KV.delete(keyNameToFetch);
        console.log(`Message with key ${keyNameToFetch} retrieved and deleted.`);

        // 8. 返回消息对象
        return new Response(JSON.stringify({ success: true, data: messageObject }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error processing GET request for random message:', error);
        // 对于 JSON 解析错误等特定错误，可以给出更具体的客户端提示
        if (error instanceof SyntaxError && error.message.includes("JSON")) {
             return new Response(JSON.stringify({ success: false, message: '无法解析存储的消息数据。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(JSON.stringify({ success: false, message: '获取消息时发生内部错误。' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

export async function onRequestPost(context) {
    return new Response("此接口用于获取消息 (GET)，提交消息请使用 POST /api/submit。", {
        status: 405, headers: { 'Allow': 'GET', 'Content-Type': 'application/json' }
    });
}