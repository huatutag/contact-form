// functions/api/message.js

export async function onRequestGet(context) {
    try {
        const { env } = context;

        // 检查 KV Namespace 是否已绑定
        if (!env.MESSAGES_KV) {
            console.error("MESSAGES_KV namespace is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误，无法获取消息 (KV_BIND)。' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 列出 KV 中的所有 key
        // 注意：对于非常大量的 key，list() 操作可能会有性能影响或限制。
        // Cloudflare KV list操作一次最多返回1000个key，如果需要更多，需要分页处理。
        // 对于“随机一条”，如果key数量不多，这种方式可行。
        const listResult = await env.MESSAGES_KV.list();
        const keys = listResult.keys;

        if (!keys || keys.length === 0) {
            return new Response(JSON.stringify({ success: true, message: '当前没有可用的消息。', data: null }), {
                status: 200, // 或者 404 Not Found，取决于你希望如何表示空状态
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 随机选择一个 key
        const randomIndex = Math.floor(Math.random() * keys.length);
        const randomKeyInfo = keys[randomIndex];

        // 根据随机选中的 key 的 name 获取其 value
        const messageString = await env.MESSAGES_KV.get(randomKeyInfo.name);

        if (messageString === null) {
            // 这种情况理论上不应该发生，如果 key 存在于列表中但无法获取
            console.error(`Could not retrieve value for key: ${randomKeyInfo.name}`);
            return new Response(JSON.stringify({ success: false, message: '无法检索到随机选择的消息内容。' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 将获取到的 JSON 字符串转换回对象
        const messageObject = JSON.parse(messageString);

        return new Response(JSON.stringify({ success: true, data: messageObject }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error processing GET request for random message:', error);
        return new Response(JSON.stringify({ success: false, message: '获取消息时发生内部错误。' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

// 如果 /api/message 路径只支持 GET，其他方法可以返回 405
export async function onRequestPost(context) {
    return new Response("此接口用于获取消息 (GET)，提交消息请使用 POST /api/submit。", {
        status: 405, // Method Not Allowed
        headers: { 'Allow': 'GET' }
    });
}
// ... 可以为其他 HTTP 方法 (PUT, DELETE 等) 添加类似的处理