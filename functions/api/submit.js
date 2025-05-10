// functions/api/submit.js

const RATE_LIMIT_DURATION_SECONDS = 10 * 60; // 10 分钟的秒数
const KV_KEY_PREFIX = "ip_submit_marker:"; // KV 键前缀，避免与其他键冲突

export async function onRequestPost(context) {
    try {
        const { request, env } = context;
        const body = await request.json();

        let messageContent = body.message;
        const token = body['cf-turnstile-response'];
        const ip = request.headers.get('CF-Connecting-IP');

        // 0. 检查必要的环境变量绑定
        if (!env.TURNSTILE_SECRET_KEY) {
            console.error("TURNSTILE_SECRET_KEY is not set in environment variables.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (T_SK)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (!env.IP_RATE_LIMIT_KV) {
            console.error("IP_RATE_LIMIT_KV (KV Namespace for IP Rate Limiting) is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (KV_BIND_RL)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }
        // D1 数据库绑定检查会稍后在尝试入库前进行

        // 1. 验证 Turnstile Token
        let formData = new FormData();
        formData.append('secret', env.TURNSTILE_SECRET_KEY);
        formData.append('response', token);
        if (ip) {
            formData.append('remoteip', ip);
        }

        const turnstileUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        const turnstileResult = await fetch(turnstileUrl, {
            body: formData,
            method: 'POST',
        });
        const turnstileOutcome = await turnstileResult.json();

        if (!turnstileOutcome.success) {
            console.log(`Turnstile verification failed for IP ${ip}:`, turnstileOutcome);
            return new Response(JSON.stringify({ success: false, message: `人机验证失败。 ${turnstileOutcome['error-codes'] ? '错误: ' + turnstileOutcome['error-codes'].join(', ') : ''}`.trim() }), {
                status: 403, headers: { 'Content-Type': 'application/json' },
            });
        }
        console.log(`Turnstile verification successful for IP ${ip}.`);

        // 2. IP 防刷检查 (Turnstile 通过后)
        if (ip) {
            const kvKey = `${KV_KEY_PREFIX}${ip}`;
            const lastSubmissionTimestampStr = await env.IP_RATE_LIMIT_KV.get(kvKey);

            if (lastSubmissionTimestampStr) {
                const lastSubmissionTimestamp = parseInt(lastSubmissionTimestampStr, 10);
                const currentTimeSeconds = Math.floor(Date.now() / 1000);
                const timeSinceLastSubmission = currentTimeSeconds - lastSubmissionTimestamp;

                if (timeSinceLastSubmission < RATE_LIMIT_DURATION_SECONDS) {
                    const timeLeftSeconds = RATE_LIMIT_DURATION_SECONDS - timeSinceLastSubmission;
                    const minutesLeft = Math.ceil(timeLeftSeconds / 60);
                    console.log(`IP ${ip} is rate-limited. Time left: ${minutesLeft} minutes.`);
                    return new Response(JSON.stringify({
                        success: false,
                        message: `操作过于频繁，请在 ${minutesLeft} 分钟后再试。`
                    }), {
                        status: 429, // Too Many Requests
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
            }
        } else {
            // 如果没有获取到 IP 地址，可以选择是放行、记录警告还是直接拒绝。
            // 当前策略是记录警告并继续，但在严格的防刷场景下可能需要调整。
            console.warn("IP address not available for rate limiting check. Proceeding without IP check.");
        }

        // 3. 输入验证
        if (messageContent === null || messageContent === undefined || typeof messageContent !== 'string') {
            return new Response(JSON.stringify({ success: false, message: '消息内容不能为空且必须为文本。' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        const trimmedMessageContent = messageContent.trim();
        const MIN_MESSAGE_LENGTH = 5;
        const MAX_MESSAGE_LENGTH = 500;

        if (trimmedMessageContent.length < MIN_MESSAGE_LENGTH) {
            return new Response(JSON.stringify({ success: false, message: `消息内容过短，至少需要 ${MIN_MESSAGE_LENGTH} 个有效字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (messageContent.length > MAX_MESSAGE_LENGTH) {
            return new Response(JSON.stringify({ success: false, message: `消息内容过长，不能超过 ${MAX_MESSAGE_LENGTH} 个字符。` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }

        let contentToStore = messageContent.replace(/<[^>]*>/g, "").trim();

        // 4. 敏感词检查
        const sensitiveCheckApiUrl = `https://v.api.aa1.cn/api/api-mgc/index.php?msg=${encodeURIComponent(contentToStore)}`;
        try {
            const sensitiveCheckResponse = await fetch(sensitiveCheckApiUrl);
            if (sensitiveCheckResponse.ok) {
                const sensitiveCheckResult = await sensitiveCheckResponse.json();
                if (sensitiveCheckResult && sensitiveCheckResult.num === "1") {
                    console.log(`Sensitive word detected for IP ${ip}:`, sensitiveCheckResult);
                    const reasonDesc = sensitiveCheckResult.desc || '检测到敏感内容';
                    const reasonCi = sensitiveCheckResult.ci || '未指定类别';
                    return new Response(JSON.stringify({
                        success: false,
                        message: `提交失败：${reasonDesc} (类别: ${reasonCi})。请修改后重试。`
                    }), {
                        status: 400, headers: { 'Content-Type': 'application/json' },
                    });
                }
            } else {
                console.warn(`Sensitive word check API request for IP ${ip} failed with status: ${sensitiveCheckResponse.status}. Proceeding with submission.`);
            }
        } catch (apiError) {
            console.error(`Sensitive word check API request for IP ${ip} failed:`, apiError);
        }

        // 5. 存库操作与更新 IP 防刷记录
        // (至此，人机验证、IP频率(读取)、输入校验、敏感词检查(如果API成功且有敏感词)都已通过或按逻辑处理)

        if (!env.DB) {
            console.error("D1 Database (DB) is not bound.");
            return new Response(JSON.stringify({ success: false, message: '服务器配置错误 (D1_BIND)。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

        const title = contentToStore.substring(0, 60);
        const receivedAt = new Date().toISOString();

        try {
            // 在真正执行数据库写入前，更新 KV 中的 IP 提交时间戳
            // 这一步表示该 IP 的本次提交尝试已通过所有验证，即将（或尝试）写入数据库
            if (ip) {
                const kvKey = `${KV_KEY_PREFIX}${ip}`;
                const currentTimeSeconds = Math.floor(Date.now() / 1000);
                try {
                    await env.IP_RATE_LIMIT_KV.put(kvKey, currentTimeSeconds.toString(), {
                        expirationTtl: RATE_LIMIT_DURATION_SECONDS // KV中的记录在30分钟后自动过期
                    });
                    console.log(`IP ${ip} rate limit marker updated in KV. Expires in ${RATE_LIMIT_DURATION_SECONDS}s.`);
                } catch (kvPutError) {
                    // 如果KV写入失败，记录错误但继续尝试数据库操作。
                    // 这意味着在极端情况下，如果KV写入持续失败，防刷效果会减弱。
                    console.error(`Failed to update IP rate limit KV for ${ip}:`, kvPutError);
                }
            }

            const stmt = env.DB.prepare(
                'INSERT INTO messages (title, content, received_at) VALUES (?, ?, ?)'
            );
            const result = await stmt.bind(title, contentToStore, receivedAt).run();

            if (result.success) {
                console.log(`Message from IP ${ip} successfully stored with ID: ${result.meta.last_row_id}.`);
                return new Response(JSON.stringify({
                    success: true,
                    message: '消息已成功提交！',
                    messageId: result.meta.last_row_id
                }), {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                });
            } else {
                console.error(`D1 Insert failed for IP ${ip}:`, result.error);
                // 注意：即使数据库插入失败，KV中的IP标记也已更新。
                // 这是为了防止通过触发数据库错误来绕过频率限制的尝试。
                return new Response(JSON.stringify({ success: false, message: '存储消息到数据库失败。' }), {
                    status: 500, headers: { 'Content-Type': 'application/json' },
                });
            }
        } catch (dbError) {
            console.error(`D1 Database error during insert for IP ${ip}:`, dbError);
            return new Response(JSON.stringify({ success: false, message: '数据库操作错误。' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }

    } catch (error) {
        // 捕获顶层的代码执行错误，例如请求体解析错误等
        console.error('Error processing POST request:', error);
        let errorMessage = '处理请求时发生内部错误。';
        if (error instanceof SyntaxError && error.message.includes("JSON")) {
            errorMessage = '请求体不是有效的JSON格式。';
        } else if (error.type === 'บัตรผ่าน' || (error.cause && error.cause.code === 'UND_ERR_CONNECT_TIMEOUT') || (error.cause && error.cause.code === 'ENOTFOUND') ) {
            // 这类错误通常是 fetch 调用外部服务（Turnstile, 敏感词API）时发生的网络问题
            console.error('Fetch error (e.g., network issue with Turnstile, Sensitive API or D1):', error);
            errorMessage = '与外部服务通信时发生网络错误，请稍后重试。';
        }
        return new Response(JSON.stringify({ success: false, message: errorMessage }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }
}

export async function onRequestGet(context) {
    // 保持不变，提示此端点仅用于POST
    return new Response("此接口用于提交消息 (POST)，获取消息请使用 GET /api/message。", {
        status: 405, headers: { 'Allow': 'POST' }
    });
}