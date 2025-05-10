// script.js

document.addEventListener('DOMContentLoaded', () => {
    const contactForm = document.getElementById('contactForm');
    const messageInput = document.getElementById('message');
    const submitButton = document.getElementById('submitButton');
    const formStatus = document.getElementById('formStatus');
    let turnstileToken = null;
    const localStorageKey = 'savedMessageContent'; // 用于 localStorage 的键

    // 1. 页面加载时尝试恢复草稿
    const savedMessage = localStorage.getItem(localStorageKey);
    if (savedMessage) {
        messageInput.value = savedMessage;
        console.log('草稿已恢复。');
    }

    // 2. 监听输入并保存到 localStorage
    messageInput.addEventListener('input', () => {
        localStorage.setItem(localStorageKey, messageInput.value);
    });

    // Turnstile 回调函数
    window.onTurnstileVerified = function (token) {
        console.log('Turnstile verified:', token);
        turnstileToken = token;
        submitButton.disabled = false; // 验证成功后启用提交按钮

        // 如果之前有错误或过期提示，清除它们
        if (formStatus.textContent.includes('验证') || formStatus.textContent.includes('错误代码')) {
            formStatus.className = 'status-message';
            formStatus.textContent = '';
        }
        // showStatus('验证成功，您可以提交了。', 'success'); // 可选提示
    };

    window.onTurnstileExpired = function () {
        console.log('Turnstile token expired.');
        turnstileToken = null;
        showStatus('人机验证已过期，请重试。', 'error');
        if (typeof turnstile !== 'undefined') {
            turnstile.reset();
        }
        submitButton.disabled = true; // 建议禁用，直到重新验证
    };

    window.onTurnstileError = function (errorCode) {
        console.error('Turnstile error:', errorCode);
        turnstileToken = null;
        showStatus('人机验证加载失败，请刷新页面或稍后再试。错误代码: ' + errorCode, 'error');
        submitButton.disabled = true; // 发生错误时禁用提交
    };

    contactForm.addEventListener('submit', async function(event) {
        event.preventDefault();
        submitButton.disabled = true;
        formStatus.textContent = '';
        formStatus.className = 'status-message';

        const message = messageInput.value.trim();
        if (!message) {
            showStatus('请输入消息内容。', 'error');
            submitButton.disabled = false;
            return;
        }

        const currentToken = turnstileToken || this.elements['cf-turnstile-response']?.value;

        if (!currentToken) {
            showStatus('人机验证未完成或已过期，请完成验证后重试。', 'error');
            submitButton.disabled = false;
            if (typeof turnstile !== 'undefined') {
                turnstile.reset();
            }
            return;
        }

        showStatus('正在提交，请稍候...', 'info');

        try {
            const response = await fetch('/api/submit', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message: message,
                    'cf-turnstile-response': currentToken,
                    'action': document.querySelector('.cf-turnstile').dataset.action || '' // 发送action
                }),
            });

            const result = await response.json();

            if (response.ok && result.success) {
                showStatus('短信发送成功。', 'success');
                contactForm.reset(); // 清空表单
                localStorage.removeItem(localStorageKey); // 3. 成功提交后清除草稿
                turnstileToken = null;
                if (typeof turnstile !== 'undefined') {
                     turnstile.reset();
                }
            } else {
                let errorMessage = result.message || '提交失败，请稍后再试。';
                 // 人机验证失败时，后端返回的 status 可能是 403
                if (response.status === 403) {
                     errorMessage = `人机验证失败：${result.message || '请重试。'}`;
                } else if (!result.success && result.message) {
                    errorMessage = result.message; // 使用后端提供的具体错误信息
                }
                showStatus(errorMessage.trim(), 'error');
                if (typeof turnstile !== 'undefined') {
                     turnstile.reset();
                }
            }
        } catch (error) {
            console.error('提交错误:', error);
            showStatus('发生网络错误，请检查您的连接并重试。', 'error');
            if (typeof turnstile !== 'undefined') {
                 turnstile.reset();
            }
        } finally {
            // 决定按钮状态：通常在出错或验证过期时禁用，验证成功时启用
            if (turnstileToken) { // 如果token仍然有效（例如，managed模式下可能如此）
                 submitButton.disabled = false;
            } else {
                 submitButton.disabled = true; // 默认禁用，等待新的验证
            }
        }
    });

    function showStatus(message, type) {
        formStatus.textContent = message;
        formStatus.className = 'status-message';
        if (type) {
            formStatus.classList.add(type);
        }
        formStatus.classList.add('show');
    }

    // 根据 Turnstile 的 data-appearance 属性来决定初始按钮状态
    const turnstileWidget = document.querySelector('.cf-turnstile');
    if (turnstileWidget) {
        const appearance = turnstileWidget.dataset.appearance;
        if (appearance === 'interaction-only') {
            submitButton.disabled = true; // interaction-only 模式初始禁用按钮
        } else {
            // 对于 'managed' 或 'non-interactive'，按钮初始可以是启用的
            // 但最好还是等 onTurnstileVerified 回调来启用，以确保token已获取
             submitButton.disabled = true; // 统一初始禁用，由回调启用
        }
    } else {
        // 如果没有找到Turnstile小部件，也禁用按钮并提示错误
        showStatus('Turnstile人机验证小部件未正确加载。', 'error');
        submitButton.disabled = true;
    }
});
