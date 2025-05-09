document.addEventListener('DOMContentLoaded', () => {
    const contactForm = document.getElementById('contactForm');
    const messageInput = document.getElementById('message');
    const submitButton = document.getElementById('submitButton');
    const formStatus = document.getElementById('formStatus');

    contactForm.addEventListener('submit', async function(event) {
        event.preventDefault();
        submitButton.disabled = true;
        formStatus.textContent = '';
        formStatus.className = 'status-message'; // Reset classes

        const message = messageInput.value.trim();
        if (!message) {
            showStatus('请输入消息内容。', 'error');
            submitButton.disabled = false;
            return;
        }

        // 从表单中获取 Turnstile 令牌
        // Turnstile widget 会自动将 token 注入到名为 'cf-turnstile-response' 的隐藏 input 中
        const turnstileToken = this.elements['cf-turnstile-response']?.value;

        if (!turnstileToken) {
            showStatus('无法验证请求，请确保人机验证已加载。', 'error');
            submitButton.disabled = false;
            // 尝试重置 Turnstile (如果需要)
            // if (typeof turnstile !== 'undefined') {
            //     turnstile.reset();
            // }
            return;
        }

        try {
            const response = await fetch('/api/submit', { // 指向我们的 Worker
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message: message,
                    'cf-turnstile-response': turnstileToken
                }),
            });

            const result = await response.json();

            if (response.ok && result.success) {
                showStatus('消息提交成功！感谢您的反馈。', 'success');
                contactForm.reset(); // 清空表单
                // Cloudflare Turnstile 会在成功提交后自动重置，或在特定时间后过期
                // 如果需要手动重置：
                if (typeof turnstile !== 'undefined') {
                     turnstile.reset();
                }
            } else {
                showStatus(result.message || '提交失败，请稍后再试。', 'error');
                // 如果是 Turnstile 验证失败，也可能需要重置
                if (typeof turnstile !== 'undefined' && response.status === 403) {
                     turnstile.reset();
                }
            }
        } catch (error) {
            console.error('提交错误:', error);
            showStatus('发生网络错误，请检查您的连接。', 'error');
        } finally {
            submitButton.disabled = false;
        }
    });

    function showStatus(message, type) {
        formStatus.textContent = message;
        formStatus.className = `status-message ${type}`;
    }
});