document.addEventListener('DOMContentLoaded', () => {
    const contactForm = document.getElementById('contactForm');
    const messageInput = document.getElementById('message');
    const submitButton = document.getElementById('submitButton');
    const formStatus = document.getElementById('formStatus');
    let turnstileToken = null; // 用于存储Turnstile令牌

    // Turnstile 回调函数
    window.onTurnstileVerified = function (token) {
        console.log('Turnstile verified:', token);
        turnstileToken = token;
        // 可以在这里启用提交按钮，如果之前是禁用的
        // submitButton.disabled = false;
        // showStatus('验证成功，您可以提交了。', 'success'); // 可选提示
    };

    window.onTurnstileExpired = function () {
        console.log('Turnstile token expired.');
        turnstileToken = null;
        showStatus('人机验证已过期，请重试。', 'error');
        // 可能需要重置Turnstile或禁用提交按钮
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
        formStatus.className = 'status-message'; // Reset classes

        const message = messageInput.value.trim();
        if (!message) {
            showStatus('请输入消息内容。', 'error');
            submitButton.disabled = false;
            return;
        }

        // 从回调中获取Turnstile令牌，或者如果appearance不是interaction-only，可以尝试从表单元素获取
        const currentToken = turnstileToken || this.elements['cf-turnstile-response']?.value;

        if (!currentToken) {
            showStatus('人机验证未完成或已过期，请稍候或重试。', 'error');
            submitButton.disabled = false;
            if (typeof turnstile !== 'undefined') {
                turnstile.reset(); // 尝试重置
            }
            return;
        }

        showStatus('正在提交，请稍候...', 'info'); // 添加一个处理中的状态

        try {
            const response = await fetch('/api/submit', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message: message,
                    'cf-turnstile-response': currentToken,
                    // 可以选择性地将 action 或 cdata 也发送到后端进行更严格的校验
                    // 'action': 'contact_form_submission' // 如果你在后端校验这个
                }),
            });

            const result = await response.json();

            if (response.ok && result.success) {
                showStatus('短信发送成功。', 'success');
                contactForm.reset(); // 清空表单
                turnstileToken = null; // 重置令牌状态
                if (typeof turnstile !== 'undefined') {
                     turnstile.reset(); // 重置Turnstile小部件以供下次使用
                }
            } else {
                let errorMessage = result.message || '提交失败，请稍后再试。';
                if (response.status === 403) {
                     errorMessage = '人机验证失败，请重试。 ' + (result.message || '');
                }
                showStatus(errorMessage.trim(), 'error');
                if (typeof turnstile !== 'undefined') {
                     turnstile.reset(); // 验证失败或出错时也重置
                }
            }
        } catch (error) {
            console.error('提交错误:', error);
            showStatus('发生网络错误，请检查您的连接并重试。', 'error');
            if (typeof turnstile !== 'undefined') {
                 turnstile.reset();
            }
        } finally {
            // 根据情况决定是否恢复按钮，通常成功后表单重置，按钮会保持可提交状态
            // 如果是interaction-only，可能需要用户再次交互来重新验证
            if (contactForm.elements['cf-turnstile-response']?.value || turnstileToken) {
                 submitButton.disabled = false;
            } else if(document.querySelector('.cf-turnstile[data-appearance="interaction-only"]')) {
                 submitButton.disabled = true; // 如果是交互模式且没有token，保持禁用
            } else {
                 submitButton.disabled = false; // 其他情况启用
            }
        }
    });

    function showStatus(message, type) {
        formStatus.textContent = message;
        // 确保先移除所有可能的类型类，再添加当前的类型类和show类
        formStatus.className = 'status-message';
        if (type) {
            formStatus.classList.add(type);
        }
        formStatus.classList.add('show'); // 添加show类以显示
    }

    // 如果Turnstile设置为 interaction-only，用户可能需要先与表单交互
    // 我们可以通过监听输入框的聚焦事件来“激活”提交按钮（如果Turnstile已经验证过）
    if (document.querySelector('.cf-turnstile[data-appearance="interaction-only"]')) {
        messageInput.addEventListener('focus', () => {
            if (turnstileToken) { // 如果之前已经通过回调获取了token
                // submitButton.disabled = false; // 这可能太早，还是等验证成功回调
            }
        });
        // 初始时，如果 data-appearance="interaction-only"，提交按钮可以是禁用的，直到Turnstile验证
        submitButton.disabled = true;
        // 监听 Turnstile 渲染完成的事件 (如果需要)
        // document.addEventListener('turnstile.render', function(event) {
        //     const widgetId = event.detail.widgetId;
        //     console.log("Turnstile widget rendered: " + widgetId);
        //     if(turnstileToken){ // 如果已有token
        //       submitButton.disabled = false;
        //     } else {
        //       submitButton.disabled = true;
        //     }
        // });

        // 或者，更简单的方式是，依赖 onTurnstileVerified 回调来启用按钮
        const originalOnVerified = window.onTurnstileVerified;
        window.onTurnstileVerified = function(token) {
            if (originalOnVerified) originalOnVerified(token);
            submitButton.disabled = false; // 验证成功后启用提交按钮
            // 清除可能存在的因 token 过期或错误而显示的消息
            if (formStatus.textContent.includes('验证') || formStatus.textContent.includes('error')) {
                formStatus.className = 'status-message';
                formStatus.textContent = '';
            }
        };
    }
});