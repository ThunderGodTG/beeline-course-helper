// ==UserScript==
// @name         芯位蜜线 - 自动下一章与后台计时
// @namespace    https://www.beeline-ai.com/
// @version      2.0.0
// @homepageURL  https://github.com/ThunderGodTG/beeline-course-helper
// @supportURL   https://github.com/ThunderGodTG/beeline-course-helper/issues
// @downloadURL  https://raw.githubusercontent.com/ThunderGodTG/beeline-course-helper/main/beeline-course-helper.user.js
// @updateURL    https://raw.githubusercontent.com/ThunderGodTG/beeline-course-helper/main/beeline-course-helper.user.js
// @description  自动点击结束弹窗的下一章按钮，并为课程播放器增加后台计时兼容。
// @match        https://*.beeline-ai.com/*
// @match        http://*.beeline-ai.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

// 先安装计时兼容，以便捕获播放器随后创建的计时器。
(() => {
    'use strict';

    if (!location.pathname.startsWith('/student/')) return;
    if (window.__beelineBackgroundClockV1) return;
    Object.defineProperty(window, '__beelineBackgroundClockV1', { value: true });

    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const functionToString = Function.prototype.toString;
    const timers = new Map();
    let worker = null;
    let workerReady = false;
    let workerUnavailable = false;
    let longestGap = 0;
    let status = null;

    function updateStatus() {
        if (!status) return;
        const message = workerUnavailable
            ? 'Worker受限，已保留网站原计时'
            : timers.size
                ? workerReady ? `已接管${timers.size}个课程计时器` : '正在启动兼容计时'
                : '等待视频播放（安装后需刷新）';
        const gap = longestGap >= 5 ? `；曾停顿${Math.round(longestGap)}秒` : '';
        const text = `后台计时：${message}${gap}`;
        if (status.textContent !== text) status.textContent = text;
    }

    function mountStatus() {
        if (status) return;
        status = document.createElement('div');
        status.id = 'beeline-background-clock-status';
        status.title = '课程计时兼容状态；此提示不代表服务器已保存进度。';
        status.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;' +
            'z-index:2147483647;padding:8px 12px;border-radius:7px;' +
            'background:#164e63;color:white;font:12px/1.5 sans-serif;' +
            'max-width:90vw;box-sizing:border-box;pointer-events:none;';
        (document.body || document.documentElement).appendChild(status);
        updateStatus();
    }

    function workerFailed(error) {
        if (workerUnavailable) return;
        workerUnavailable = true;
        workerReady = false;
        worker?.terminate();
        worker = null;
        // 原生计时器始终保留；Worker不可用时不影响网站原有行为。
        console.warn('[蜜线后台计时] Worker不可用，继续使用网站原计时。', error);
        updateStatus();
    }

    function ensureWorker() {
        if (worker || workerUnavailable) return;
        let blobUrl;
        try {
            blobUrl = URL.createObjectURL(new Blob([`
                const timers = new Map();
                self.onmessage = ({ data }) => {
                    if (data.type === 'start') {
                        clearInterval(timers.get(data.id));
                        timers.set(data.id, setInterval(() => {
                            self.postMessage({ type: 'tick', id: data.id });
                        }, data.delay));
                    } else if (data.type === 'stop') {
                        clearInterval(timers.get(data.id));
                        timers.delete(data.id);
                    }
                };
                self.postMessage({ type: 'ready' });
            `], { type: 'text/javascript' }));
            worker = new Worker(blobUrl);
            worker.onmessage = ({ data }) => {
                if (data.type === 'ready') {
                    workerReady = true;
                    updateStatus();
                } else if (data.type === 'tick') {
                    timers.get(data.id)?.deliver();
                }
            };
            worker.onerror = workerFailed;
        } catch (error) {
            workerFailed(error);
        } finally {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
        }
    }

    function postToWorker(message) {
        try {
            worker?.postMessage(message);
        } catch (error) {
            workerFailed(error);
        }
    }

    function isCourseClock(callback, delay) {
        if (typeof callback !== 'function' || delay !== 1000) return false;
        const source = functionToString.call(callback);
        // 只匹配已核对的播放器进度计时回调，其他网站定时器原样执行。
        return source.includes('recordTimeDelay') && source.includes('recordCount') &&
            source.includes('getPlaybackRate');
    }

    function reportCallbackError(error) {
        if (typeof window.reportError === 'function') window.reportError(error);
        else console.error('[蜜线后台计时] 网站计时回调异常', error);
    }

    window.setInterval = function setInterval(callback, delay, ...args) {
        if (!isCourseClock(callback, delay)) return nativeSetInterval(callback, delay, ...args);

        const startedAt = performance.now();
        const entry = {
            lastRun: startedAt,
            nextDue: startedAt + delay,
            running: false,
            cancelled: false
        };
        entry.deliver = () => {
            if (entry.cancelled || entry.running) return;
            const now = performance.now();
            const elapsed = now - entry.lastRun;
            // 共用截止时间防止双重触发；2ms仅用于容忍浏览器计时精度。
            if (now + 2 < entry.nextDue) return;
            // 保留每秒节奏；长时间停顿后不补跑积压回调。
            entry.nextDue = now - entry.nextDue >= delay
                ? now + delay : entry.nextDue + delay;
            entry.lastRun = now;
            if (elapsed > 5000) {
                longestGap = Math.max(longestGap, elapsed / 1000);
                updateStatus();
            }
            entry.running = true;
            try {
                const result = Reflect.apply(callback, window, args);
                Promise.resolve(result).then(() => {
                    entry.running = false;
                }, error => {
                    entry.running = false;
                    reportCallbackError(error);
                });
            } catch (error) {
                entry.running = false;
                reportCallbackError(error);
            }
        };

        const id = nativeSetInterval(entry.deliver, delay);
        timers.set(id, entry);
        ensureWorker();
        postToWorker({ type: 'start', id, delay });
        updateStatus();
        return id;
    };

    function cancelTrackedTimer(id) {
        const entry = timers.get(id);
        if (!entry) return;
        entry.cancelled = true;
        timers.delete(id);
        postToWorker({ type: 'stop', id });
        if (!timers.size) {
            worker?.terminate();
            worker = null;
            workerReady = false;
        }
        updateStatus();
    }

    window.clearInterval = function clearInterval(id) {
        cancelTrackedTimer(id);
        return nativeClearInterval(id);
    };
    // 浏览器的两种清除方法可交叉使用，保留同样的取消语义。
    window.clearTimeout = function clearTimeout(id) {
        cancelTrackedTimer(id);
        return nativeClearTimeout(id);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountStatus, { once: true });
    } else mountStatus();
})();

// 自动跳转需要操作DOM，等待页面结构就绪后启动。
function startBeelineAutoNext() {
    (() => {
        'use strict';

        if (document.getElementById('beeline-auto-next-status')) return;

        const CLICK_DELAY = 1000; // 弹窗出现后等待多久，单位：毫秒。
        // 来自页面实际结构；不依赖弹窗标题、冒号或重看按钮的文字。
        const NEXT_SELECTOR = '.watch-next-chapter .button-box .right';
        let enabled = true;
        let currentButton = null;
        let handled = false;
        let clickedAt = 0;
        let clickError = false;
        let clickTimer = null;
        let scanTimer = null;

        const status = document.createElement('button');
        status.id = 'beeline-auto-next-status';
        status.type = 'button';
        status.title = '点击暂停或恢复自动下一章';
        status.style.cssText = 'all:initial;position:fixed;left:12px;bottom:12px;' +
            'z-index:2147483647;padding:9px 12px;border-radius:7px;' +
            'background:#172554;color:#fff;font:12px/1.5 sans-serif;' +
            'max-width:90vw;box-sizing:border-box;cursor:pointer;' +
            'box-shadow:0 2px 10px #0003;';
        (document.body || document.documentElement).appendChild(status);

        function setStatus(message) {
            const text = `自动下一章：${message}`;
            if (status.textContent !== text) status.textContent = text;
        }

        function textOf(element) {
            return (element.textContent || '').replace(/\s+/g, '');
        }

        function isVisible(element) {
            if (!element.isConnected || element.closest('[hidden], [aria-hidden="true"], [inert]')) {
                return false;
            }
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            for (let node = element; node; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden' ||
                    style.visibility === 'collapse' || Number(style.opacity) === 0) {
                    return false;
                }
            }
            return true;
        }

        function findNextButton() {
            for (const button of document.querySelectorAll(NEXT_SELECTOR)) {
                if (isVisible(button) && textOf(button).includes('观看下一章')) return button;
            }
            return null;
        }

        function isDisabled(button) {
            return Boolean(button.closest(':disabled, [aria-disabled="true"], .is-disabled, .disabled'));
        }

        function clearPendingClick() {
            clearTimeout(clickTimer);
            clickTimer = null;
        }

        function scheduleScan() {
            if (scanTimer !== null) return;
            scanTimer = setTimeout(() => {
                scanTimer = null;
                scan();
            }, 100);
        }

        function scan() {
            if (!enabled) {
                clearPendingClick();
                setStatus('已暂停，点击此处恢复');
                return;
            }

            const button = findNextButton();
            if (button !== currentButton) {
                clearPendingClick();
                currentButton = button;
                handled = false;
                clickError = false;
            }
            if (!button) {
                setStatus('已运行，等待结束弹窗');
                return;
            }
            if (handled) {
                setStatus(clickError ? '点击失败，请查看控制台' :
                    Date.now() - clickedAt > 5000 ? '已点击，但弹窗仍显示' : '已点击，等待切换');
                return;
            }
            if (isDisabled(button)) {
                clearPendingClick();
                setStatus('下一章按钮暂不可用，等待中');
                return;
            }
            if (clickTimer !== null) return;

            setStatus('检测到结束弹窗，1秒后切换');
            clickTimer = setTimeout(() => {
                clickTimer = null;
                const latestButton = findNextButton();
                if (!enabled || !latestButton || latestButton !== currentButton || isDisabled(latestButton)) {
                    scheduleScan();
                    return;
                }
                // 点击文字所在的内层div，兼容监听器绑定在内层或外层.right的情况。
                const target = Array.from(latestButton.querySelectorAll('button, a, div, span'))
                    .reverse().find(node => textOf(node).includes('观看下一章') && isVisible(node))
                    || latestButton;
                // 点击前标记，避免点击引发页面变化时重复触发。
                handled = true;
                clickedAt = Date.now();
                try {
                    target.click();
                    console.info('[蜜线自动下一章] 已点击下一章按钮', target);
                } catch (error) {
                    clickError = true;
                    console.error('[蜜线自动下一章] 点击失败', error);
                }
                scheduleScan();
            }, CLICK_DELAY);
        }

        status.addEventListener('click', () => {
            enabled = !enabled;
            clearPendingClick();
            currentButton = null;
            handled = false;
            scan();
        });

        new MutationObserver(scheduleScan).observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'disabled', 'aria-disabled', 'inert', 'open']
        });

        // 兼容弹窗复用、样式动画等未及时捕获的显示变化。
        setInterval(scan, 750);
        document.addEventListener('visibilitychange', scan);
        scan();
    })();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startBeelineAutoNext, { once: true });
} else startBeelineAutoNext();
})();
