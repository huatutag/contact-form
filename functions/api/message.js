// functions/api/message.js

export async function onRequestGet(context) {
    try {
        const { request, env } = context;

        // 1. API Key 验证 (这部分逻辑不变)
        const GET_MESSAGES_API_KEY = env.GET_MESSAGES_API_KEY;
        if (!GET_MESSAGES_API_KEY) {
            console.error("GET_MESSAGES_API_KEY is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (K_ENV)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }
        const url = new URL(request.url);
        const apiKeyFromRequest = url.searchParams.get('key');
        if (!apiKeyFromRequest) {
             return new Response(JSON.stringify({ success: false, message: '请求缺少 API Key。' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (apiKeyFromRequest !== GET_MESSAGES_API_KEY) {
            return new Response(JSON.stringify({ success: false, message: '无效的 API Key。' }), {
                status: 401, headers: { 'Content-Type': 'application/json' },
            });
        }

        // 2. 检查 D1 数据库是否已绑定
        if (!env.DB) {
            console.error("D1 Database (DB) is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (D1_BIND)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

        let messageToReturn = null;
        let attempts = 0;
        const maxAttempts = 3; // 重试几次以防并发冲突

        // D1 不像 KV 那样有 list() 后随机选key再get/delete的简单模式。
        // 我们需要先随机选一条，然后删除它。这可能需要原子操作或重试以处理并发。
        // SQLite 的 ORDER BY RANDOM() LIMIT 1 是获取随机行的常用方法。

        while (!messageToReturn && attempts < maxAttempts) {
            attempts++;
            try {
                // 尝试获取一个随机消息
                // D1的 .batch() 可以将多个语句作为事务执行
                // 但这里我们需要先获取ID，然后用这个ID去删除，
                // 或者直接获取整个行然后删除。
                // 为简单起见，我们先获取，再删除。
                // 更安全的做法是使用事务，但D1的函数API中事务不那么直接，
                // 或者使用更复杂的SQL（如窗口函数选取后删除）。

                const selectStmt = env.DB.prepare(
                    'SELECT id, title, content, received_at FROM messages ORDER BY RANDOM() LIMIT 1'
                );
                const randomMessage = await selectStmt.first();

                if (!randomMessage) {
                    if (attempts === 1) { // 仅在第一次尝试时报告“无消息”
                        return new Response(JSON.stringify({ success: true, message: '当前没有可用的消息。', data: null }), {
                            status: 200, headers: { 'Content-Type': 'application/json' },
                        });
                    }
                    // 如果后续尝试中没有消息，说明可能已被其他并发请求处理
                    break; // 退出循环
                }

                // 获取到消息，现在尝试删除它
                const deleteStmt = env.DB.prepare('DELETE FROM messages WHERE id = ?');
                const deleteResult = await deleteStmt.bind(randomMessage.id).run();

                if (deleteResult.success && deleteResult.meta.changes > 0) {
                    // 成功删除，可以返回消息
                    messageToReturn = {
                        id: randomMessage.id,
                        title: randomMessage.title,
                        content: randomMessage.content,
                        received_at: randomMessage.received_at,
                    };
                } else if (deleteResult.meta.changes === 0) {
                    // 未删除任何行，说明该行可能在SELECT和DELETE之间被另一个请求删除了
                    // 这种情况会导致循环重试
                    console.warn(`Message with id ${randomMessage.id} was selected but not deleted. Retrying if attempts left.`);
                    // messageToReturn 保持 null，将触发重试
                } else {
                    // 删除操作本身失败
                    console.error(`Failed to delete message with id ${randomMessage.id}:`, deleteResult.error);
                    // 可以选择立即失败或依赖重试
                    // messageToReturn 保持 null
                }

            } catch (dbError) {
                console.error(`D1 Database error during get/delete (attempt ${attempts}):`, dbError);
                if (attempts >= maxAttempts) { // 如果是最后一次尝试且出错
                    return new Response(JSON.stringify({ success: false, message: '数据库操作错误。' }), {
                        status: 500, headers: { 'Content-Type': 'application/json' },
                    });
                }
                // 否则，错误可能是暂时的，循环会继续/重试
            }
        } // end while loop

        if (messageToReturn) {
            return new Response(JSON.stringify({ success: true, data: messageToReturn }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        } else {
            // 如果循环结束仍未获取到消息（可能因为并发或多次尝试后数据库确实为空）
            return new Response(JSON.stringify({ success: true, message: '未能获取消息，可能已被处理或当前无消息。', data: null }), {
                status: 200, // 或 404，取决于您想如何表达“最终没拿到”
                headers: { 'Content-Type': 'application/json' },
            });
        }


    } catch (error) { // 通用外部 try-catch
        console.error('Error processing GET request for random message:', error);
        return new Response(JSON.stringify({ success: false, message: '获取消息时发生内部错误。' }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }
}

// 其他 HTTP 方法的处理保持不变
export async function onRequestPost(context) {
    return new Response("此接口用于获取消息 (GET)，提交消息请使用 POST /api/submit。", {
        status: 405, headers: { 'Allow': 'GET' }
    });
}
