/* ====================================================================
 * 通用 MCP 设置面板 UI
 *
 * 依赖: McpGenericClient / McpBridge
 *
 * 暴露: window.McpUIList
 *   - initSettings()    初始化设置面板 (在 DOMContentLoaded 后调用)
 *   - refresh()         重渲染整个设置面板
 *   - openEditModal(s)  打开编辑弹窗 (s = null 表示添加)
 *
 * 职责:
 *   1. 渲染服务器列表 (每项: 名称/URL/工具数/状态/操作按钮)
 *   2. 添加 / 编辑 / 删除 / 测试连接 / 启用 / 停用
 *   3. 编辑弹窗 (含基础字段 + 自定义请求头)
 *   4. 聊天绑定 (charIds)
 *
 * 跟旧 mcp-ui-init.js 的差异:
 *   - 完全动态生成 DOM (不依赖预存 id)
 *   - 删掉 mcd-mcp-toggle / luckin-mcp-toggle / mcd-mcp-token-input 等硬编码元素
 *   - 删掉 mcd 卡片 / luckin 卡片, 改成通用 server 卡片
 *   - 删掉 brand-specific 触发词检测 (findMcdActivation / findLuckinActivation)
 *   - 删掉 brand-specific 工具栏按钮 (mcd/luckin icon button)
 * ==================================================================== */

(function (global) {
    'use strict';

    if (!global.McpGenericClient) {
        console.warn('[McpUIList] McpGenericClient 未加载, 跳过初始化');
        return;
    }

    // ========== 常量 ==========

    const SECTION_ID = 'mcp-settings-section';
    const MODAL_ID = 'mcp-edit-modal';

    // 主题色 (跟 330 现有 mcp-settings-skyblue 风格一致)
    const COLORS = {
        primary: '#1E88E5',
        primaryDark: '#1565C0',
        bg: '#F5F9FF',
        cardBg: '#FFFFFF',
        text: '#1F2937',
        subText: '#6B7280',
        ok: '#10B981',
        err: '#EF4444',
        warn: '#F59E0B',
        border: '#E5E7EB',
    };

    // ========== 工具函数 ==========

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function shortId(len) {
        len = len || 8;
        return Math.random().toString(36).slice(2, 2 + len);
    }
    function toast(msg, level) {
        level = level || 'info';
        let t = document.getElementById('mcp-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'mcp-toast';
            t.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);background:rgba(0,0,0,.85);color:#fff;padding:10px 16px;border-radius:14px;font-size:13px;line-height:1.4;z-index:99999;opacity:0;transition:opacity .2s;pointer-events:none;max-width:80%;text-align:center;';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.opacity = '1';
        if (level === 'success') t.style.background = 'linear-gradient(135deg,#34D399,#10B981)';
        else if (level === 'warn') t.style.background = 'linear-gradient(135deg,#FBBF24,#F59E0B)';
        else if (level === 'err') t.style.background = 'linear-gradient(135deg,#F87171,#EF4444)';
        else t.style.background = 'rgba(0,0,0,.85)';
        clearTimeout(t._timer);
        t._timer = setTimeout(function () { t.style.opacity = '0'; }, 3000);
    }

    // ========== 热门 MCP 推荐 (5 分钟接入引导) ==========

    const RECOMMEND_LIST = [
        {
            icon: '🔍',
            name: '网页搜索 (Exa AI)',
            url: 'https://mcp.exa.ai/mcp',
            tokenHint: '去 exa.ai 注册拿 API Key (免费 1000 次/月)',
            playTip: '"查一下 XX 最新消息" / "帮我搜 XX 官网"',
            signUpUrl: 'https://exa.ai',
        },
        {
            icon: '🦁',
            name: '网页搜索 (Brave)',
            url: 'https://mcp.brave.com/mcp',
            tokenHint: '去 brave.com/search/api 注册拿 API Key (免费 2000 次/月)',
            playTip: '跟 Exa 类似, 备选',
            signUpUrl: 'https://brave.com/search/api/',
        },
        {
            icon: '🌤',
            name: '天气查询 (自部署)',
            url: 'http://localhost:端口/mcp',
            tokenHint: 'GitHub 搜 mcp-weather 跑本地 (要 Node 环境)',
            playTip: '"今天 XX 天气怎么样"',
            signUpUrl: 'https://github.com/modelcontextprotocol/servers',
        },
        {
            icon: '📁',
            name: '文件系统 (自部署)',
            url: 'http://localhost:端口/mcp',
            tokenHint: '@modelcontextprotocol/server-filesystem 跑本地',
            playTip: '"读一下我桌面上 XX.pdf" / "整理下我下载文件夹"',
            signUpUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem',
        },
    ];

    function renderRecommendItem(item) {
        return '' +
            '<div style="background:rgba(255,255,255,.6);border:1px solid #FED7AA;border-radius:8px;padding:10px 12px;">' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
                    '<span style="font-size:18px;">' + escapeHtml(item.icon) + '</span>' +
                    '<strong style="font-size:13px;color:#1F2937;">' + escapeHtml(item.name) + '</strong>' +
                '</div>' +
                '<div style="font-size:11px;color:#6B7280;margin-bottom:8px;line-height:1.6;">' +
                    '<div style="margin-bottom:3px;">🔑 ' + escapeHtml(item.tokenHint) + '</div>' +
                    '<div>💡 玩法: ' + escapeHtml(item.playTip) + '</div>' +
                '</div>' +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                    '<button data-role="copy-url" data-url="' + escapeHtml(item.url) + '" style="padding:4px 10px;background:#fff;color:' + COLORS.primary + ';border:1px solid ' + COLORS.primary + ';border-radius:6px;font-size:11px;cursor:pointer;">📋 复制 URL</button>' +
                    '<a href="' + escapeHtml(item.signUpUrl) + '" target="_blank" rel="noopener" style="padding:4px 10px;background:#fff;color:#6B7280;border:1px solid ' + COLORS.border + ';border-radius:6px;font-size:11px;text-decoration:none;display:inline-block;">🔗 拿 Token / 注册</a>' +
                '</div>' +
            '</div>';
    }

    function renderRecommendBlock() {
        const items = RECOMMEND_LIST.map(renderRecommendItem).join('');
        return '' +
            '<div style="background:linear-gradient(135deg,#FEF3C7,#FED7AA);border-radius:10px;padding:12px 14px;margin-bottom:14px;">' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
                    '<span style="font-size:16px;">🌟</span>' +
                    '<strong style="font-size:14px;color:#92400E;">5 分钟接入热门服务</strong>' +
                    '<button data-role="open-tutorial" style="background:#fff;color:#92400E;border:1px solid #F59E0B;border-radius:6px;padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer;margin-left:auto;">📖 完整图文教程</button>' +
                '</div>' +
                '<div style="display:flex;flex-direction:column;gap:8px;">' + items + '</div>' +
                '<div style="font-size:11px;color:#92400E;margin-top:10px;line-height:1.5;opacity:.85;">' +
                    '💡 流程: 复制 URL → 去对应网站拿 Token/Cookie → 回这里点"+ 添加 MCP 服务器"粘贴 → 测试连接 → 启用' +
                '</div>' +
            '</div>';
    }

    function bindRecommendEvents() {
        document.querySelectorAll('[data-role="copy-url"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const url = btn.getAttribute('data-url');
                if (!url) return;
                const original = btn.textContent;
                function showCopied() {
                    btn.textContent = '✓ 已复制';
                    toast('URL 已复制: ' + url, 'success');
                    setTimeout(function () { btn.textContent = original; }, 1500);
                }
                function fallback() {
                    const ta = document.createElement('textarea');
                    ta.value = url;
                    ta.style.cssText = 'position:fixed;left:-9999px;';
                    document.body.appendChild(ta);
                    ta.select();
                    try { document.execCommand('copy'); showCopied(); }
                    catch (e) { toast('复制失败, 手动复制: ' + url, 'warn'); }
                    ta.remove();
                }
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(url).then(showCopied).catch(fallback);
                } else {
                    fallback();
                }
            });
        });
    }

    // ========== 完整图文教程弹窗 ==========

    const TUTORIAL_STEPS = [
        {
            icon: '🔍',
            name: '网页搜索 (Exa AI)',
            steps: [
                '打开 <a href="https://exa.ai" target="_blank" rel="noopener">exa.ai</a> 注册账号 (免费 1000 次/月够用)',
                '登录后到 Dashboard → API Keys → 复制你的 API Key',
                '回 330 → 点 "+ 添加 MCP 服务器" → 名称填 "Exa" → URL 粘贴 <code>https://mcp.exa.ai/mcp</code> → Bearer Token 粘贴 API Key',
                '点 "测试连接" → 看到 "✓ 已连接, N 个工具" → 保存 → 启用开关',
                '回聊天, 对 AI 说 "查一下 XX 最新消息" 或 "帮我搜 XX 官网"',
            ],
            tip: '💡 Exa 是 AI 友好的搜索引擎, 搜出来的内容直接喂给 AI 总结。免费档 1000 次够玩一个月。',
        },
        {
            icon: '🦁',
            name: '网页搜索 (Brave)',
            steps: [
                '打开 <a href="https://brave.com/search/api/" target="_blank" rel="noopener">brave.com/search/api</a> 注册 (免费 2000 次/月)',
                '订阅 Free tier → 拿到 API Key',
                '回 330 → 名称 "Brave" → URL <code>https://mcp.brave.com/mcp</code> → Bearer Token 填 API Key',
                '测试连接 → 启用 → 聊天用',
            ],
            tip: '💡 Brave 跟 Exa 类似, 二选一即可。Exa 偏 AI 友好, Brave 偏传统搜索。',
        },
        {
            icon: '🌤',
            name: '天气查询 (自部署)',
            steps: [
                '需要你电脑装了 Node.js (没装先装: <a href="https://nodejs.org" target="_blank" rel="noopener">nodejs.org</a>)',
                '打开终端跑: <code>npx -y @modelcontextprotocol/server-weather</code> (默认监听 stdio, 需要先确认该包支持 Streamable HTTP)',
                '<b>注意</b>: 多数官方 reference server 是 stdio 模式 (本机子进程), 浏览器调不了. 要么用 npx 包自带的 HTTP 模式, 要么用 <a href="https://github.com/modelcontextprotocol/servers" target="_blank" rel="noopener">社区 HTTP 包装版</a>',
                '跑起来后看输出: "Listening on http://localhost:3000/mcp"',
                '回 330 → 名称 "天气" → URL 填 <code>http://localhost:3000/mcp</code> → 测试连接 → 启用',
                '聊天说 "今天上海天气怎么样" AI 自动查',
            ],
            tip: '💡 自部署需要电脑一直开着. 想手机也能用, 套 Cloudflare Tunnel 透传 (零基础参考: <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/" target="_blank" rel="noopener">Cloudflare 文档</a>)。',
        },
        {
            icon: '📁',
            name: '文件系统 (自部署)',
            steps: [
                '装 Node.js 后跑: <code>npx -y @modelcontextprotocol/server-filesystem /Users/你的用户名/Desktop</code> (Desktop 换成你想让 AI 访问的目录)',
                '同样多数是 stdio 模式, 找带 HTTP 模式的包装版, 或用 supergateway 包装: <code>npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem /path/to/dir"</code>',
                '跑起来后记下 URL (通常是 <code>http://localhost:8000/mcp</code>)',
                '回 330 → 名称 "文件" → URL 填这个 → 测试连接 → 启用',
                '聊天说 "读一下我桌面上 XX.pdf" / "整理下我下载文件夹"',
            ],
            tip: '💡 <b style="color:#B91C1C">安全警告</b>: AI 能读 / 写 / 删那个目录的文件! 不要指向根目录或敏感文件夹, 建议先开一个专门的 "AI 工作" 文件夹。',
        },
    ];

    function openTutorialModal() {
        let modal = document.getElementById('mcp-tutorial-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'mcp-tutorial-modal';
            modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99998;display:none;align-items:center;justify-content:center;padding:20px;';
            document.body.appendChild(modal);
        }
        const sections = TUTORIAL_STEPS.map(function (t) {
            const stepsHtml = t.steps.map(function (s, i) {
                return '<li style="margin-bottom:4px;">' + s + '</li>';
            }).join('');
            return '<details style="background:#F9FAFB;border:1px solid ' + COLORS.border + ';border-radius:8px;padding:10px 12px;margin-bottom:8px;">' +
                '<summary style="cursor:pointer;font-size:14px;font-weight:600;color:' + COLORS.text + ';list-style:none;">' +
                    '<span style="font-size:18px;margin-right:6px;">' + t.icon + '</span>' + escapeHtml(t.name) +
                    '<span style="float:right;color:' + COLORS.subText + ';font-size:12px;font-weight:normal;">点击展开 ▼</span>' +
                '</summary>' +
                '<ol style="margin:10px 0 0;padding-left:20px;font-size:13px;line-height:1.7;color:' + COLORS.text + ';">' + stepsHtml + '</ol>' +
                '<div style="margin-top:8px;padding:8px 10px;background:#FEF3C7;border-left:3px solid #F59E0B;border-radius:4px;font-size:12px;line-height:1.6;color:#92400E;">' + t.tip + '</div>' +
            '</details>';
        }).join('');

        modal.innerHTML = '<div data-role="modal-content" style="background:#fff;border-radius:14px;width:100%;max-width:600px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.2);">' +
            '<div style="padding:20px;">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">' +
                    '<div>' +
                        '<div style="font-size:17px;font-weight:600;color:' + COLORS.text + ';">📖 MCP 完整图文教程</div>' +
                        '<div style="font-size:12px;color:' + COLORS.subText + ';margin-top:2px;">5 个常用服务 · 点章节展开看步骤</div>' +
                    '</div>' +
                    '<button data-role="tutorial-close" style="background:none;border:none;font-size:22px;cursor:pointer;color:' + COLORS.subText + ';">×</button>' +
                '</div>' +
                sections +
                '<div style="margin-top:14px;padding:12px;background:' + COLORS.bg + ';border-radius:8px;font-size:12px;line-height:1.6;color:' + COLORS.subText + ';">' +
                    '<b style="color:' + COLORS.text + ';">通用流程</b> (所有服务都适用):<br>' +
                    '① 拿 URL + Token/Cookie → ② 添加 server → ③ 测试连接看到工具清单 → ④ 启用 → ⑤ 回聊天对 AI 说<br><br>' +
                    '<b style="color:' + COLORS.text + ';">遇到问题</b>: 报错 "Failed to fetch" 八成是 CORS, 配代理 URL; 报错 401/403 是 Token 错或过期; AI 不调工具是模型不支持 function calling, 关掉 "聊天模型支持 OpenAI function calling" 开关试试。' +
                '</div>' +
            '</div>' +
        '</div>';

        modal.style.display = 'flex';
        const closeBtn = modal.querySelector('[data-role="tutorial-close"]');
        if (closeBtn) closeBtn.addEventListener('click', function () { modal.style.display = 'none'; });
        modal.addEventListener('click', function (e) { if (e.target === modal) modal.style.display = 'none'; });
    }

    // ========== 状态徽章 (enabled / 连接中 / 已连接 / 失败) ==========

    function renderStatusBadge(server) {
        if (!server.enabled) {
            return '<span style="background:' + COLORS.border + ';color:' + COLORS.subText + ';">已停用</span>';
        }
        const tools = Array.isArray(server.tools) ? server.tools.length : 0;
        if (tools > 0) {
            return '<span style="background:' + COLORS.ok + ';color:#fff;">✓ 已连接 · ' + tools + ' 个工具</span>';
        }
        return '<span style="background:' + COLORS.warn + ';color:#fff;">未测试</span>';
    }

    // ========== Server 卡片 ==========

    function renderServerCard(server) {
        const isEnabled = !!server.enabled;
        const toolNames = (server.tools || []).slice(0, 4).map(function (t) { return t.name; }).join(', ');
        const moreCount = (server.tools || []).length > 4 ? ' +' + ((server.tools || []).length - 4) : '';
        return '' +
            '<div class="mcp-server-card" data-server-id="' + escapeHtml(server.id) + '" style="' +
                'background:' + COLORS.cardBg + ';' +
                'border:1px solid ' + COLORS.border + ';' +
                'border-radius:12px;padding:14px;margin-bottom:12px;' +
                'box-shadow:0 1px 3px rgba(0,0,0,.04);' +
            '">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">' +
                    '<div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">' +
                        '<div style="font-size:15px;font-weight:600;color:' + COLORS.text + ';">🔌 ' + escapeHtml(server.name || '(未命名)') + '</div>' +
                        renderStatusBadge(server) +
                    '</div>' +
                    '<label class="mcp-toggle" data-role="toggle" style="' +
                        'position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0;cursor:pointer;' +
                    '">' +
                        '<input type="checkbox" data-role="enabled" ' + (isEnabled ? 'checked' : '') + ' style="opacity:0;width:0;height:0;">' +
                        '<span style="position:absolute;inset:0;background:' + (isEnabled ? COLORS.primary : COLORS.border) + ';border-radius:22px;transition:.2s;">' +
                            '<span style="position:absolute;top:2px;left:' + (isEnabled ? '20px' : '2px') + ';width:18px;height:18px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 2px rgba(0,0,0,.2);"></span>' +
                        '</span>' +
                    '</label>' +
                '</div>' +
                '<div style="font-size:12px;color:' + COLORS.subText + ';word-break:break-all;margin-bottom:6px;">' +
                    '🔗 ' + escapeHtml(server.url || '(未填 URL)') +
                '</div>' +
                (toolNames ? '<div style="font-size:12px;color:' + COLORS.subText + ';margin-bottom:10px;">🔧 ' + escapeHtml(toolNames) + escapeHtml(moreCount) + '</div>' : '') +
                '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">' +
                    '<button data-role="test" style="padding:6px 12px;background:' + COLORS.bg + ';color:' + COLORS.primary + ';border:1px solid ' + COLORS.primary + ';border-radius:8px;font-size:12px;cursor:pointer;">测试连接</button>' +
                    '<button data-role="edit" style="padding:6px 12px;background:#F3F4F6;color:' + COLORS.text + ';border:1px solid ' + COLORS.border + ';border-radius:8px;font-size:12px;cursor:pointer;">编辑</button>' +
                    '<button data-role="bind" style="padding:6px 12px;background:#F3F4F6;color:' + COLORS.text + ';border:1px solid ' + COLORS.border + ';border-radius:8px;font-size:12px;cursor:pointer;">聊天绑定</button>' +
                    '<button data-role="delete" style="padding:6px 12px;background:#FEF2F2;color:' + COLORS.err + ';border:1px solid ' + COLORS.err + ';border-radius:8px;font-size:12px;cursor:pointer;margin-left:auto;">删除</button>' +
                '</div>' +
                '<div data-role="test-result" style="display:none;margin-top:10px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;"></div>' +
            '</div>';
    }

    // ========== 设置面板主区 ==========

    function renderSection() {
        const servers = global.McpGenericClient.loadServers();
        const useNative = global.McpGenericClient.getUseNativeTools();
        return '' +
            '<div style="background:linear-gradient(135deg,#DBEAFE,#E0E7FF);border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.6;color:#1E3A8A;">' +
                '<strong>🧩 通用 MCP 工具服务器</strong> · AI 角色能直接调外部工具(浏览/搜索/下单/发内容等)。' +
                '每加一个 server, 不用改前端代码, 角色自动发现工具。' +
                '⚠️ <strong style="color:#B91C1C;">有真实副作用的工具(发布/下单/删除)会真执行</strong>, 配置前请确认来源可信。' +
            '</div>' +

            '<div style="background:#FFF7ED;border-left:3px solid ' + COLORS.warn + ';padding:10px 12px;border-radius:6px;margin-bottom:14px;font-size:12px;color:#9A3412;line-height:1.5;">' +
                '<strong>怎么获取 token / cookie?</strong> 各服务不一样, 一般: ' +
                '①云端服务去对应开放平台注册生成; ' +
                '②本地电脑跑的项目用 http://localhost:端口; ' +
                '③想手机也能用就 Cloudflare Tunnel 透传; ' +
                '详细教程参考 <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener" style="color:' + COLORS.primary + ';">MCP 官网</a>。' +
            '</div>' +

            '<div id="mcp-server-list">' +
                (servers.length
                    ? servers.map(renderServerCard).join('')
                    : '<div style="background:#F9FAFB;border:1px dashed ' + COLORS.border + ';border-radius:12px;padding:24px;text-align:center;color:' + COLORS.subText + ';">' +
                        '<div style="font-size:32px;margin-bottom:8px;">🧩</div>' +
                        '<div style="font-size:13px;">还没有 MCP 服务器, 点下面添加一个</div>' +
                      '</div>'
                ) +
            '</div>' +

            renderRecommendBlock() +

            '<button id="mcp-add-btn" style="' +
                'width:100%;padding:12px;margin-top:4px;' +
                'background:linear-gradient(135deg,' + COLORS.primary + ',' + COLORS.primaryDark + ');' +
                'color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;' +
                'box-shadow:0 2px 4px rgba(30,136,229,.2);' +
            '">+ 添加 MCP 服务器</button>' +

            '<div style="background:#F3F4F6;border-radius:8px;padding:12px 14px;margin-top:14px;font-size:12px;line-height:1.6;color:' + COLORS.subText + ';">' +
                '<strong style="color:' + COLORS.text + ';">使用流程</strong>: ' +
                '① 添加 server 填 URL + token → ② 测试连接看到工具清单 → ③ 打开启用开关 → ' +
                '④ 回聊天界面对 AI 说"查一下 XX" / "帮我发个帖" / "搜索 XX", AI 会自动调对应 server 的工具。' +
                '工具调用过程以卡片形式贴在聊天里, 你能看到每一步的输入输出。' +
            '</div>' +

            '<div style="background:#F9FAFB;border-radius:8px;padding:12px 14px;margin-top:10px;font-size:12px;color:' + COLORS.subText + ';">' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                    '<input type="checkbox" id="mcp-use-native-tools" ' + (useNative ? 'checked' : '') + ' style="cursor:pointer;">' +
                    '<span>聊天模型支持 OpenAI function calling (默认开; 不支持的模型关掉会回退到文字兼容模式)</span>' +
                '</label>' +
            '</div>' +
        '';
    }

    // ========== 编辑弹窗 ==========

    function ensureModal() {
        let modal = document.getElementById(MODAL_ID);
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = MODAL_ID;
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99998;display:none;align-items:center;justify-content:center;padding:20px;';
        modal.innerHTML = '<div data-role="modal-content" style="background:#fff;border-radius:14px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.2);"></div>';
        document.body.appendChild(modal);
        return modal;
    }

    function openEditModal(server) {
        const isNew = !server;
        const s = server || {
            id: '',
            name: '',
            url: '',
            token: '',
            customHeaders: [],
            proxyUrl: '',
            proxyKey: '',
            enabled: false,
        };
        const modal = ensureModal();
        const content = modal.querySelector('[data-role="modal-content"]');
        content.innerHTML = '' +
            '<div style="padding:20px;">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">' +
                    '<div style="font-size:17px;font-weight:600;color:' + COLORS.text + ';">' + (isNew ? '添加 MCP 服务器' : '编辑 MCP 服务器') + '</div>' +
                    '<button data-role="modal-close" style="background:none;border:none;font-size:22px;cursor:pointer;color:' + COLORS.subText + ';">×</button>' +
                '</div>' +

                '<div style="margin-bottom:12px;">' +
                    '<label style="display:block;font-size:13px;color:' + COLORS.subText + ';margin-bottom:4px;">名称 (随便起, 如 "Ombre Brain")</label>' +
                    '<input data-role="f-name" type="text" value="' + escapeHtml(s.name) + '" placeholder="如: 小红书 / 天气 / 记忆库" style="width:100%;padding:10px;border:1px solid ' + COLORS.border + ';border-radius:8px;font-size:14px;box-sizing:border-box;">' +
                '</div>' +

                '<div style="margin-bottom:12px;">' +
                    '<label style="display:block;font-size:13px;color:' + COLORS.subText + ';margin-bottom:4px;">服务器 URL <span style="color:' + COLORS.err + ';">*</span></label>' +
                    '<input data-role="f-url" type="text" value="' + escapeHtml(s.url) + '" placeholder="https://mcp.example.com/mcp 或 http://localhost:18001/mcp" style="width:100%;padding:10px;border:1px solid ' + COLORS.border + ';border-radius:8px;font-size:14px;box-sizing:border-box;">' +
                '</div>' +

                '<div style="margin-bottom:12px;">' +
                    '<label style="display:block;font-size:13px;color:' + COLORS.subText + ';margin-bottom:4px;">Bearer Token (服务器要求 Authorization: Bearer ... 时填)</label>' +
                    '<input data-role="f-token" type="password" value="' + escapeHtml(s.token || '') + '" placeholder="可选" style="width:100%;padding:10px;border:1px solid ' + COLORS.border + ';border-radius:8px;font-size:14px;box-sizing:border-box;">' +
                '</div>' +

                '<div style="margin-bottom:12px;">' +
                    '<label style="display:block;font-size:13px;color:' + COLORS.subText + ';margin-bottom:4px;">自定义请求头 (非 Bearer 鉴权, 如 X-API-Key / XBY-APIKEY)</label>' +
                    '<div data-role="f-headers" style="background:#F9FAFB;border:1px solid ' + COLORS.border + ';border-radius:8px;padding:8px;">' +
                        ((s.customHeaders && s.customHeaders.length)
                            ? s.customHeaders.map(function (h, i) { return renderHeaderRow(h, i); }).join('')
                            : renderHeaderRow({ name: '', value: '' }, 0)) +
                    '</div>' +
                    '<button data-role="f-add-header" type="button" style="margin-top:6px;padding:4px 10px;background:' + COLORS.bg + ';color:' + COLORS.primary + ';border:1px dashed ' + COLORS.primary + ';border-radius:6px;font-size:12px;cursor:pointer;">+ 添加请求头</button>' +
                '</div>' +

                '<div style="background:#F3F4F6;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:' + COLORS.subText + ';">' +
                    '<strong style="color:' + COLORS.text + ';">CORS 代理</strong> (服务器 CORS 没配好才用, 留空 = 浏览器直连)' +
                '</div>' +

                '<div style="margin-bottom:12px;">' +
                    '<label style="display:block;font-size:13px;color:' + COLORS.subText + ';margin-bottom:4px;">代理 URL</label>' +
                    '<input data-role="f-proxy-url" type="text" value="' + escapeHtml(s.proxyUrl || '') + '" placeholder="https://<你的netlify域名>/.netlify/functions/mcp-proxy 或 http://localhost:18061" style="width:100%;padding:10px;border:1px solid ' + COLORS.border + ';border-radius:8px;font-size:13px;box-sizing:border-box;">' +
                    '<div style="font-size:11px;color:' + COLORS.subText + ';margin-top:4px;">约定: &lt;代理&gt;?target=&lt;服务器 URL&gt;, 工具自填 target</div>' +
                '</div>' +

                '<div style="margin-bottom:16px;">' +
                    '<label style="display:block;font-size:13px;color:' + COLORS.subText + ';margin-bottom:4px;">代理密钥 (自部署代理才填, 跟代理服务端 PROXY_KEY 环境变量对齐)</label>' +
                    '<input data-role="f-proxy-key" type="password" value="' + escapeHtml(s.proxyKey || '') + '" placeholder="可选" style="width:100%;padding:10px;border:1px solid ' + COLORS.border + ';border-radius:8px;font-size:14px;box-sizing:border-box;">' +
                '</div>' +

                '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
                    '<button data-role="modal-cancel" style="padding:8px 16px;background:#F3F4F6;color:' + COLORS.text + ';border:1px solid ' + COLORS.border + ';border-radius:8px;font-size:13px;cursor:pointer;">取消</button>' +
                    '<button data-role="modal-save" style="padding:8px 20px;background:linear-gradient(135deg,' + COLORS.primary + ',' + COLORS.primaryDark + ');color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">' + (isNew ? '添加' : '保存') + '</button>' +
                '</div>' +
            '</div>';

        modal.style.display = 'flex';

        // 绑定弹窗事件
        content.querySelector('[data-role="modal-close"]').addEventListener('click', closeEditModal);
        content.querySelector('[data-role="modal-cancel"]').addEventListener('click', closeEditModal);
        content.querySelector('[data-role="modal-save"]').addEventListener('click', function () { saveFromModal(s.id); });
        content.querySelector('[data-role="f-add-header"]').addEventListener('click', addHeaderRow);
        modal.addEventListener('click', function (e) { if (e.target === modal) closeEditModal(); });
    }

    function renderHeaderRow(h, idx) {
        return '' +
            '<div data-role="header-row" data-idx="' + idx + '" style="display:flex;gap:6px;margin-bottom:6px;">' +
                '<input data-role="h-name" type="text" value="' + escapeHtml(h.name || '') + '" placeholder="Header 名 (如 X-API-Key)" style="flex:1;padding:6px 8px;border:1px solid ' + COLORS.border + ';border-radius:6px;font-size:12px;min-width:0;">' +
                '<input data-role="h-value" type="text" value="' + escapeHtml(h.value || '') + '" placeholder="值" style="flex:2;padding:6px 8px;border:1px solid ' + COLORS.border + ';border-radius:6px;font-size:12px;min-width:0;">' +
                '<button data-role="h-remove" type="button" style="padding:4px 8px;background:#FEF2F2;color:' + COLORS.err + ';border:1px solid ' + COLORS.err + ';border-radius:6px;font-size:11px;cursor:pointer;flex-shrink:0;">×</button>' +
            '</div>';
    }

    function addHeaderRow() {
        const container = document.querySelector('[data-role="f-headers"]');
        if (!container) return;
        const idx = container.children.length;
        const wrap = document.createElement('div');
        wrap.innerHTML = renderHeaderRow({ name: '', value: '' }, idx);
        container.appendChild(wrap.firstElementChild);
        bindHeaderRowEvents(container.lastElementChild);
    }

    function bindHeaderRowEvents(row) {
        if (!row) return;
        const remove = row.querySelector('[data-role="h-remove"]');
        if (remove) {
            remove.addEventListener('click', function () {
                row.remove();
            });
        }
    }

    function closeEditModal() {
        const modal = document.getElementById(MODAL_ID);
        if (modal) modal.style.display = 'none';
    }

    function saveFromModal(editId) {
        const modal = document.getElementById(MODAL_ID);
        if (!modal) return;
        const content = modal.querySelector('[data-role="modal-content"]');
        const name = (content.querySelector('[data-role="f-name"]').value || '').trim();
        const url = (content.querySelector('[data-role="f-url"]').value || '').trim();
        const token = content.querySelector('[data-role="f-token"]').value || '';
        const proxyUrl = (content.querySelector('[data-role="f-proxy-url"]').value || '').trim();
        const proxyKey = content.querySelector('[data-role="f-proxy-key"]').value || '';

        if (!name) { toast('请填名称', 'err'); return; }
        if (!url) { toast('请填服务器 URL', 'err'); return; }
        if (!/^https?:\/\//i.test(url) && !/^http:\/\/localhost/i.test(url)) {
            toast('URL 必须以 http:// 或 https:// 开头', 'err');
            return;
        }

        // 收集 headers
        const headerRows = content.querySelectorAll('[data-role="header-row"]');
        const customHeaders = [];
        headerRows.forEach(function (row) {
            const n = (row.querySelector('[data-role="h-name"]').value || '').trim();
            const v = (row.querySelector('[data-role="h-value"]').value || '').trim();
            if (n && v) customHeaders.push({ name: n, value: v });
        });

        const servers = global.McpGenericClient.loadServers();
        let server;
        if (editId) {
            server = servers.find(function (x) { return x.id === editId; });
            if (!server) { toast('找不到这个服务器', 'err'); return; }
            server.name = name;
            server.url = url;
            server.token = token;
            server.customHeaders = customHeaders;
            server.proxyUrl = proxyUrl;
            server.proxyKey = proxyKey;
            server.updatedAt = Date.now();
        } else {
            server = global.McpGenericClient.createServer(name, url);
            server.token = token;
            server.customHeaders = customHeaders;
            server.proxyUrl = proxyUrl;
            server.proxyKey = proxyKey;
            servers.push(server);
        }
        global.McpGenericClient.saveServers(servers);
        closeEditModal();
        refresh();
        toast(editId ? '已保存' : '已添加, 点测试连接验证', 'success');
    }

    // ========== 操作 ==========

    async function testConnection(serverId) {
        const servers = global.McpGenericClient.loadServers();
        const server = servers.find(function (x) { return x.id === serverId; });
        if (!server) return;
        const card = document.querySelector('.mcp-server-card[data-server-id="' + serverId + '"]');
        if (!card) return;
        const resultEl = card.querySelector('[data-role="test-result"]');
        const testBtn = card.querySelector('[data-role="test"]');

        if (testBtn) { testBtn.disabled = true; testBtn.textContent = '测试中…'; }
        if (resultEl) {
            resultEl.style.display = 'block';
            resultEl.style.background = '#F3F4F6';
            resultEl.style.color = COLORS.subText;
            resultEl.textContent = '正在连接 ' + server.url + '…';
        }

        try {
            const r = await global.McpGenericClient.testConnection(server);
            if (r.ok) {
                // 把测试回来的 tools 写回 server (持久化)
                const fresh = global.McpGenericClient.loadServers();
                const target = fresh.find(function (x) { return x.id === serverId; });
                if (target) {
                    target.tools = r.tools || [];
                    target.updatedAt = Date.now();
                    global.McpGenericClient.saveServers(fresh);
                }
                if (resultEl) {
                    resultEl.style.background = '#D1FAE5';
                    resultEl.style.color = '#065F46';
                    const names = (r.tools || []).map(function (t) { return t.name; }).join(', ');
                    resultEl.textContent = '✓ ' + r.message + (names ? '\n工具: ' + names : '');
                }
                toast('已连接, ' + (r.tools || []).length + ' 个工具', 'success');
            } else {
                if (resultEl) {
                    resultEl.style.background = '#FEE2E2';
                    resultEl.style.color = '#991B1B';
                    resultEl.textContent = '✗ ' + (r.message || '连接失败');
                }
                toast('连接失败: ' + (r.message || '').slice(0, 60), 'err');
            }
        } catch (e) {
            if (resultEl) {
                resultEl.style.background = '#FEE2E2';
                resultEl.style.color = '#991B1B';
                resultEl.textContent = '✗ ' + ((e && e.message) || String(e));
            }
            toast('测试失败: ' + ((e && e.message) || '').slice(0, 60), 'err');
        } finally {
            if (testBtn) { testBtn.disabled = false; testBtn.textContent = '测试连接'; }
            // 1.5s 后刷新卡片状态徽章
            setTimeout(refresh, 1500);
        }
    }

    function toggleServer(serverId) {
        const servers = global.McpGenericClient.loadServers();
        const s = servers.find(function (x) { return x.id === serverId; });
        if (!s) return;
        s.enabled = !s.enabled;
        s.updatedAt = Date.now();
        global.McpGenericClient.saveServers(servers);
        refresh();
    }

    function deleteServer(serverId) {
        const servers = global.McpGenericClient.loadServers();
        const s = servers.find(function (x) { return x.id === serverId; });
        if (!s) return;
        if (!confirm('确定删除 "' + s.name + '"?\n相关配置和已发现工具会一并清除, 已保存的聊天不会受影响。')) return;
        const newList = servers.filter(function (x) { return x.id !== serverId; });
        global.McpGenericClient.saveServers(newList);
        global.McpGenericClient.resetSession(serverId);
        refresh();
        toast('已删除', 'success');
    }

    function editCharBinding(serverId) {
        const servers = global.McpGenericClient.loadServers();
        const s = servers.find(function (x) { return x.id === serverId; });
        if (!s) return;
        // 简单实现: 让用户输入"通用 / 仅某角色" — 后续可换成角色多选 UI
        const cur = (s.charIds || []).join(',');
        const input = prompt(
            '聊天绑定 (留空 = 通用, 所有聊天可见)\n' +
            '如要只对某角色/群聊生效, 填角色 ID 或群聊 ID, 多个用英文逗号分隔\n\n' +
            '当前: ' + (cur || '(通用)'),
            cur
        );
        if (input === null) return; // 取消
        const trimmed = input.trim();
        if (!trimmed) {
            s.charIds = [];
        } else {
            s.charIds = trimmed.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        }
        s.updatedAt = Date.now();
        global.McpGenericClient.saveServers(servers);
        refresh();
        toast('已更新聊天绑定', 'success');
    }

    // ========== 事件绑定 ==========

    function bindEvents() {
        const addBtn = document.getElementById('mcp-add-btn');
        if (addBtn) addBtn.addEventListener('click', function () { openEditModal(null); });

        const useNativeCb = document.getElementById('mcp-use-native-tools');
        if (useNativeCb) {
            useNativeCb.addEventListener('change', function () {
                global.McpGenericClient.setUseNativeTools(useNativeCb.checked);
                toast(useNativeCb.checked ? '已启用 function calling' : '已切换到文字兼容模式', 'info');
            });
        }

        document.querySelectorAll('.mcp-server-card').forEach(function (card) {
            const id = card.getAttribute('data-server-id');
            const toggleInput = card.querySelector('[data-role="enabled"]');
            if (toggleInput) {
                toggleInput.addEventListener('change', function () { toggleServer(id); });
            }
            card.querySelector('[data-role="test"]').addEventListener('click', function () { testConnection(id); });
            card.querySelector('[data-role="edit"]').addEventListener('click', function () {
                const servers = global.McpGenericClient.loadServers();
                const s = servers.find(function (x) { return x.id === id; });
                if (s) openEditModal(s);
            });
            card.querySelector('[data-role="bind"]').addEventListener('click', function () { editCharBinding(id); });
            card.querySelector('[data-role="delete"]').addEventListener('click', function () { deleteServer(id); });
        });

        // header rows
        document.querySelectorAll('[data-role="header-row"]').forEach(bindHeaderRowEvents);

        // 热门推荐复制按钮 + 教程按钮
        bindRecommendEvents();
        const tutorialBtn = document.querySelector('[data-role="open-tutorial"]');
        if (tutorialBtn) tutorialBtn.addEventListener('click', openTutorialModal);
    }

    // ========== 入口 ==========

    function initSettings() {
        const section = document.getElementById(SECTION_ID);
        if (!section) {
            // 设置分区 DOM 还没注入, 等一会再试
            return false;
        }
        section.innerHTML = renderSection();
        bindEvents();
        return true;
    }

    function refresh() {
        initSettings();
    }

    global.McpUIList = {
        initSettings: initSettings,
        refresh: refresh,
        openEditModal: openEditModal,
    };

    // 等 DOM + McpGenericClient 都就绪再初始化
    function tryInit() {
        if (!global.McpGenericClient) {
            setTimeout(tryInit, 100);
            return;
        }
        if (typeof document === 'undefined') return;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', tryInit);
            return;
        }
        if (!initSettings()) {
            // 设置分区还没渲染, 延迟 500ms 再试
            setTimeout(tryInit, 500);
        }
    }
    setTimeout(tryInit, 50);

    console.log('[McpUIList] 通用 MCP UI 已加载 (依赖 McpGenericClient)');

})(typeof window !== 'undefined' ? window : globalThis);
