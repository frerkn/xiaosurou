// ========================================
// 连接APP - 独立联机功能管理器 (完全重写)
// 不再与QQ聊天系统共享任何数据
// ========================================

class OnlineChatManager {
    constructor() {
        this.ws = null;
        this.userId = null;
        this.nickname = null;
        this.avatar = null;
        this.serverUrl = null;
        this.isConnected = false;
        this.friendRequests = [];
        this.onlineFriends = [];
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.shouldAutoReconnect = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 999;
        this.heartbeatMissed = 0;
        this.maxHeartbeatMissed = 3;
        this.lastHeartbeatTime = null;
        this.groupHistoryPullDebounceMs = 30000; // 切回前台/重连成功后 30s 内不重复拉同一群历史
        this.lastGroupHistoryPullAt = {};
        // 【群聊自愈/补差标记】重连（包括切后台恢复时主动 connect）后置 true，
        // onRegisterSuccess 完成一次增量补差后清掉。openChat / visibilitychange
        // 不再无条件拉历史，只有这个标记为 true 时才走增量补差，避免"退一下聊天框
        // 就拉、切一下后台就拉"的体验灾难。
        this._needsResync = false;

        this.chats = {};
        this.activeChatId = null;

        this.myAiCharacter = null;
        this.aiCharactersInGroup = {};
        this.isAiResponding = false;
        this.isOnlineSummaryRunning = false;

        // 【长聊闪退修复】saveChats debounce timer——
        // 每条消息同步 stringify + localStorage.setItem 是把主线程卡死的元凶。
        // 这里把 saveChats() 改成 trailing debounce：
        //   - 800ms 内的连续调用合并成 1 次实际写入
        //   - 主线程不再被密集切片占用 → 手机 WebView 不会被杀进程
        //   - 字段在这里初始化，避免在 saveChats 里第一次用到时 undefined
        this._saveChatsTimer = null;
    }

    _getStorageKey(suffix) {
        return `online-app-${this.userId || 'default'}-${suffix}`;
    }

    saveChats() {
        // 【长聊闪退修复】debounced 落盘：
        //   - 每 800ms 内多次 saveChats() 调用合并成 1 次实际 localStorage.setItem
        //   - 主线程不再被每条消息的 JSON.stringify + setItem 切片占用
        //   - 调用点不用改（addOnlineGroupMessage / onReceiveGroupMessage / sendCurrentMessage 等几十处）
        //   - 不动 onclose / disconnect / beforeunload 路径，避免上次"点搜索就崩"的回归
        if (this._saveChatsTimer) {
            clearTimeout(this._saveChatsTimer);
        }
        this._saveChatsTimer = setTimeout(() => {
            this._saveChatsTimer = null;
            try {
                const data = JSON.stringify(this.chats);
                localStorage.setItem(this._getStorageKey('chats'), data);
            } catch (e) {
                console.error('保存连接APP聊天数据失败:', e);
                if (this._isQuotaError(e)) {
                    this._pruneHistories();
                    try {
                        localStorage.setItem(this._getStorageKey('chats'), JSON.stringify(this.chats));
                        console.warn('[群聊] 存储空间不足，已裁剪最旧历史后重新保存');
                    } catch (e2) {
                        console.error('裁剪历史后仍无法保存聊天数据:', e2);
                    }
                }
            }
        }, 800);
    }

    _isQuotaError(e) {
        if (!e) return false;
        return e.name === 'QuotaExceededError'
            || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
            || e.code === 22
            || e.code === 1014;
    }

    _pruneHistories(keep = 200) {
        for (const chatId in this.chats) {
            const chat = this.chats[chatId];
            if (chat && Array.isArray(chat.history) && chat.history.length > keep) {
                chat.history = chat.history.slice(-keep);
            }
        }
    }

    loadChats() {
        try {
            const data = localStorage.getItem(this._getStorageKey('chats'));
            if (data) {
                this.chats = JSON.parse(data);
            }
        } catch (e) {
            console.error('加载连接APP聊天数据失败:', e);
            this.chats = {};
        }
    }

    _mergeChatsFromStorage() {
        let stored = {};
        try {
            const data = localStorage.getItem(this._getStorageKey('chats'));
            if (data) stored = JSON.parse(data) || {};
        } catch (e) {
            console.error('加载连接APP聊天数据失败:', e);
            return;
        }

        if (!this.chats || Object.keys(this.chats).length === 0) {
            this.chats = stored;
            return;
        }

        for (const [chatId, storedChat] of Object.entries(stored)) {
            const memChat = this.chats[chatId];
            if (!memChat) {
                this.chats[chatId] = storedChat;
                continue;
            }
            this._mergeHistory(memChat, storedChat);
            if ((storedChat.timestamp || 0) > (memChat.timestamp || 0)) {
                memChat.lastMessage = storedChat.lastMessage || memChat.lastMessage;
                memChat.timestamp = storedChat.timestamp;
            }
        }
    }

    _historyKeyOf(m) {
        if (!m) return '';
        if (m.messageId) return m.messageId;
        if (m.clientMessageId) return m.clientMessageId;
        return `${m.role || ''}_${m.timestamp || 0}_${String(m.content || '').slice(0, 80)}`;
    }

    _mergeHistory(memChat, storedChat) {
        const memHistory = Array.isArray(memChat.history) ? memChat.history : [];
        const storedHistory = Array.isArray(storedChat.history) ? storedChat.history : [];

        const seen = new Set();
        const merged = [];
        for (const m of storedHistory) {
            const k = this._historyKeyOf(m);
            if (seen.has(k)) continue;
            seen.add(k);
            merged.push(m);
        }
        for (const m of memHistory) {
            const k = this._historyKeyOf(m);
            if (seen.has(k)) continue;
            seen.add(k);
            merged.push(m);
        }
        merged.sort(this._sortByTime);
        memChat.history = merged;
    }

    /**
     * 消息排序比较器：优先用客户端"接收时间" `_receivedAt`（最准确反映用户看到的顺序），
     * 回退到 created_at / timestamp。
     *
     * 为什么不用 timestamp / created_at 直接排序：
     * - 本地发的消息 timestamp = Date.now() (客户端时钟)
     * - 服务端来的消息 created_at = 服务端时钟
     * - 客户端和服务端时钟不一致时，timestamp 排序会把本地刚发的消息排到中间。
     *
     * `_receivedAt` 是消息被本机记录的本地时间，永远单调递增，最能反映"用户看到的顺序"。
     */
    _sortByTime(a, b) {
        const timeA = a._receivedAt || a.created_at || a.timestamp || 0;
        const timeB = b._receivedAt || b.created_at || b.timestamp || 0;
        if (timeA !== timeB) return timeA - timeB;
        const idA = a.messageId || '';
        const idB = b.messageId || '';
        return idA.localeCompare(idB);
    }

    saveFriendRequests() {
        try {
            localStorage.setItem(this._getStorageKey('friend-requests'), JSON.stringify(this.friendRequests));
        } catch (e) { console.error('保存好友申请失败:', e); }
    }
    loadFriendRequests() {
        try {
            const data = localStorage.getItem(this._getStorageKey('friend-requests'));
            if (data) this.friendRequests = JSON.parse(data);
        } catch (e) { this.friendRequests = []; }
    }
    saveOnlineFriends() {
        try {
            localStorage.setItem(this._getStorageKey('friends'), JSON.stringify(this.onlineFriends));
        } catch (e) { console.error('保存好友列表失败:', e); }
    }
    loadOnlineFriends() {
        try {
            const data = localStorage.getItem(this._getStorageKey('friends'));
            if (data) this.onlineFriends = JSON.parse(data);
        } catch (e) { this.onlineFriends = []; }
    }

    async compressImage(file, maxWidth = 200, maxHeight = 200, quality = 0.8) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    let w = img.width, h = img.height;
                    if (w > maxWidth) { h = h * maxWidth / w; w = maxWidth; }
                    if (h > maxHeight) { w = w * maxHeight / h; h = maxHeight; }
                    canvas.width = w;
                    canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                };
                img.onerror = reject;
                img.src = e.target.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    getSafeAvatar() {
        if (!this.avatar) return 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
        if (this.avatar.startsWith('data:image/') && this.avatar.length > 50000) {
            return 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
        }
        return this.avatar;
    }

    initUI() {
        const enableSwitch = document.getElementById('online-app-enable-switch');
        const detailsDiv = document.getElementById('online-app-settings-details');

        if (enableSwitch) {
            enableSwitch.addEventListener('change', (e) => {
                detailsDiv.style.display = e.target.checked ? 'block' : 'none';
                if (!e.target.checked) {
                    this.shouldAutoReconnect = false;
                    this.reconnectAttempts = 0;
                    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
                    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
                    if (this.ws) { this.isConnected = false; try { this.ws.close(); } catch (e2) {} this.ws = null; }
                    this.updateConnectionUI(false);
                }
                this.saveSettings();
            });
        }

        const uploadBtn = document.getElementById('online-app-upload-avatar-btn');
        const resetBtn = document.getElementById('online-app-reset-avatar-btn');
        const avatarInput = document.getElementById('online-app-avatar-input');
        const avatarPreview = document.getElementById('online-app-avatar-preview');

        if (uploadBtn && avatarInput) {
            uploadBtn.addEventListener('click', () => avatarInput.click());
            avatarInput.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (file) {
                    try {
                        this.avatar = await this.compressImage(file, 200, 200, 0.8);
                        avatarPreview.src = this.avatar;
                        this.saveSettings();
                        if (this.isConnected) {
                            this.send({ type: 'register', userId: this.userId, nickname: this.nickname, avatar: this.getSafeAvatar() });
                        }
                    } catch (err) { alert('头像上传失败: ' + err.message); }
                }
                e.target.value = '';
            });
        }
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this.avatar = 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
                avatarPreview.src = this.avatar;
                this.saveSettings();
                if (this.isConnected) {
                    this.send({ type: 'register', userId: this.userId, nickname: this.nickname, avatar: this.avatar });
                }
            });
        }

        const connectBtn = document.getElementById('online-app-connect-btn');
        const disconnectBtn = document.getElementById('online-app-disconnect-btn');
        if (connectBtn) connectBtn.addEventListener('click', () => this.connect());
        if (disconnectBtn) disconnectBtn.addEventListener('click', () => this.disconnect());

        const searchBtn = document.getElementById('online-app-search-btn');
        if (searchBtn) searchBtn.addEventListener('click', () => this.searchFriend());
        const searchDoBtn = document.getElementById('online-app-search-do-btn');
        if (searchDoBtn) searchDoBtn.addEventListener('click', () => this.doSearch());
        const searchInput = document.getElementById('online-app-search-id');
        if (searchInput) searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.doSearch();
        });

        const reqBtn = document.getElementById('online-app-friend-requests-btn');
        if (reqBtn) reqBtn.addEventListener('click', () => this.openFriendRequestsModal());

        const createGroupBtn = document.getElementById('online-app-create-group-btn');
        if (createGroupBtn) createGroupBtn.addEventListener('click', () => this.openCreateGroupModal());

        const groupInfoBtn = document.getElementById('online-app-group-info-btn');
        if (groupInfoBtn) groupInfoBtn.addEventListener('click', () => this.openGroupInfoModal());

        const deployTutorialBtn = document.getElementById('online-app-deploy-tutorial-btn');
        if (deployTutorialBtn) deployTutorialBtn.addEventListener('click', () => window.open('online-help-deploy.html', '_blank'));

        const guideTutorialBtn = document.getElementById('online-app-guide-tutorial-btn');
        if (guideTutorialBtn) guideTutorialBtn.addEventListener('click', () => window.open('online-help-guide.html', '_blank'));

        const explainTutorialBtn = document.getElementById('online-app-explain-tutorial-btn');
        if (explainTutorialBtn) explainTutorialBtn.addEventListener('click', () => window.open('online-help-explain.html', '_blank'));

        const clearBtn = document.getElementById('online-app-clear-cache-btn');
        if (clearBtn) clearBtn.addEventListener('click', () => this.clearAllOldData());

        const resetDataBtn = document.getElementById('online-app-reset-btn');
        if (resetDataBtn) resetDataBtn.addEventListener('click', () => this.resetOnlineData());

        const settingsBtn = document.getElementById('online-app-settings-btn');
        if (settingsBtn) settingsBtn.addEventListener('click', () => this.showView('online-app-settings-view'));

        const settingsBack = document.getElementById('online-app-settings-back');
        if (settingsBack) settingsBack.addEventListener('click', () => this.showView('online-app-list-view'));

        const addBtn = document.getElementById('online-app-add-btn');
        if (addBtn) addBtn.addEventListener('click', () => this.showView('online-app-settings-view'));

        const backToList = document.getElementById('online-app-back-to-list');
        if (backToList) backToList.addEventListener('click', () => {
            this.activeChatId = null;
            this.showView('online-app-list-view');
        });

        const sendBtn = document.getElementById('online-app-send-btn');
        const chatInput = document.getElementById('online-app-chat-input');
        if (sendBtn) {
            sendBtn.addEventListener('click', () => this.sendCurrentMessage());
        }
        if (chatInput) {
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendCurrentMessage();
                }
            });
            chatInput.addEventListener('input', () => {
                chatInput.style.height = 'auto';
                chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';
            });
            chatInput.addEventListener('focus', () => {
                const panel = document.getElementById('online-sticker-panel');
                if (panel) panel.style.display = 'none';
            });
        }

        const stickerBtn = document.getElementById('online-app-sticker-btn');
        if (stickerBtn) stickerBtn.addEventListener('click', () => this.toggleStickerPanel());
        const stickerCloseBtn = document.getElementById('online-sticker-close-btn');
        if (stickerCloseBtn) stickerCloseBtn.addEventListener('click', () => {
            const panel = document.getElementById('online-sticker-panel');
            if (panel) panel.style.display = 'none';
        });
        const stickerAddBtn = document.getElementById('online-sticker-add-btn');
        if (stickerAddBtn) stickerAddBtn.addEventListener('click', () => this.addSticker());
        const stickerUploadInput = document.getElementById('online-sticker-upload-input');
        if (stickerUploadInput) stickerUploadInput.addEventListener('change', (e) => {
            this.handleStickerUpload(e.target.files[0]);
            e.target.value = '';
        });

        this.loadSettings();
        this.setupVisibilityListener();
        this.setupBeforeUnloadListener();
        this.autoReconnectIfNeeded();
    }

    showView(viewId) {
        document.querySelectorAll('#online-app-screen .online-app-view').forEach(v => v.classList.remove('active'));
        const view = document.getElementById(viewId);
        if (view) view.classList.add('active');

        if (viewId === 'online-app-list-view') {
            this.renderChatList();
        }
    }

    updateConnectionUI(connected) {
        const statusDot = document.getElementById('online-app-status-dot');
        const statusText = document.getElementById('online-app-status-text');
        const connStatus = document.getElementById('online-app-conn-status');
        const connectBtn = document.getElementById('online-app-connect-btn');
        const disconnectBtn = document.getElementById('online-app-disconnect-btn');

        if (connected) {
            if (statusDot) { statusDot.className = 'status-dot-online'; }
            if (statusText) statusText.textContent = '已连接';
            if (connStatus) { connStatus.textContent = '已连接'; connStatus.style.color = '#34c759'; }
            if (connectBtn) connectBtn.style.display = 'none';
            if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
        } else {
            if (statusDot) { statusDot.className = 'status-dot-offline'; }
            if (statusText) statusText.textContent = '未连接';
            if (connStatus) { connStatus.textContent = '未连接'; connStatus.style.color = '#999'; }
            if (connectBtn) connectBtn.style.display = 'inline-block';
            if (disconnectBtn) disconnectBtn.style.display = 'none';
        }
    }

    updateConnectingUI() {
        const statusDot = document.getElementById('online-app-status-dot');
        const statusText = document.getElementById('online-app-status-text');
        const connStatus = document.getElementById('online-app-conn-status');
        if (statusDot) statusDot.className = 'status-dot-connecting';
        if (statusText) statusText.textContent = '连接中...';
        if (connStatus) { connStatus.textContent = '连接中...'; connStatus.style.color = '#ff9500'; }
    }

    saveSettings() {
        try {
            const settings = {
                enabled: document.getElementById('online-app-enable-switch')?.checked || false,
                userId: document.getElementById('online-app-my-id')?.value || '',
                nickname: document.getElementById('online-app-my-nickname')?.value || '',
                avatar: this.avatar || '',
                serverUrl: document.getElementById('online-app-server-url')?.value || '',
                wasConnected: this.shouldAutoReconnect
            };
            const str = JSON.stringify(settings);
            if (str.length > 5 * 1024 * 1024) settings.avatar = '';
            localStorage.setItem('online-app-settings', JSON.stringify(settings));
        } catch (e) {
            console.error('保存连接APP设置失败:', e);
            try {
                const min = {
                    enabled: document.getElementById('online-app-enable-switch')?.checked || false,
                    userId: document.getElementById('online-app-my-id')?.value || '',
                    nickname: document.getElementById('online-app-my-nickname')?.value || '',
                    avatar: '',
                    serverUrl: document.getElementById('online-app-server-url')?.value || '',
                    wasConnected: this.shouldAutoReconnect
                };
                localStorage.setItem('online-app-settings', JSON.stringify(min));
            } catch (err) { console.error('保存简化设置也失败:', err); }
        }
    }

    loadSettings() {
        const saved = localStorage.getItem('online-app-settings');
        const oldSaved = !saved ? localStorage.getItem('ephone-online-settings') : null;
        const raw = saved || oldSaved;

        if (raw) {
            try {
                const s = JSON.parse(raw);
                const enableSwitch = document.getElementById('online-app-enable-switch');
                const detailsDiv = document.getElementById('online-app-settings-details');
                const idInput = document.getElementById('online-app-my-id');
                const nickInput = document.getElementById('online-app-my-nickname');
                const avatarPreview = document.getElementById('online-app-avatar-preview');
                const serverInput = document.getElementById('online-app-server-url');

                if (enableSwitch) {
                    enableSwitch.checked = s.enabled;
                    if (detailsDiv) detailsDiv.style.display = s.enabled ? 'block' : 'none';
                }
                if (idInput) {
                    idInput.value = s.userId || '';
                    this.userId = s.userId || null;
                }
                if (nickInput) nickInput.value = s.nickname || '';
                if (serverInput) serverInput.value = s.serverUrl || '';

                if (s.avatar && (s.avatar.startsWith('data:image/') || s.avatar.startsWith('http'))) {
                    this.avatar = s.avatar;
                    if (avatarPreview) avatarPreview.src = s.avatar;
                } else {
                    this.avatar = 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
                    if (avatarPreview) avatarPreview.src = this.avatar;
                }

                if (s.wasConnected && s.enabled) this.shouldAutoReconnect = true;

                if (oldSaved && !saved) {
                    this.saveSettings();
                    console.log('已从旧版设置迁移到连接APP');
                }
            } catch (e) {
                console.error('加载连接APP设置失败:', e);
                this.avatar = 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
            }
        } else {
            this.avatar = 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
            const avatarPreview = document.getElementById('online-app-avatar-preview');
            if (avatarPreview) avatarPreview.src = this.avatar;
        }

        this.loadFriendRequests();
        this.loadOnlineFriends();
        this.loadChats();
        this.loadAiCharacters();
    }

    async connect() {
        const idInput = document.getElementById('online-app-my-id');
        const nickInput = document.getElementById('online-app-my-nickname');
        const serverInput = document.getElementById('online-app-server-url');

        this.userId = idInput?.value.trim();
        this.nickname = nickInput?.value.trim();
        this.serverUrl = serverInput?.value.trim();

        if (!this.userId) { alert('请设置你的ID'); return; }
        if (!this.nickname) { alert('请设置你的昵称'); return; }
        if (!this.serverUrl) { alert('请输入服务器地址'); return; }

        this.friendRequests = [];
        this.onlineFriends = [];
        this.loadFriendRequests();
        this.loadOnlineFriends();
        this._mergeChatsFromStorage();

        // 【群聊补差】连接（无论是首次还是重连）都视为一次可能漏消息的机会，
        // 在 onRegisterSuccess 完成后走增量补差。openChat / visibilitychange
        // 不会再无条件拉历史。
        this._needsResync = true;

        if (this.ws) {
            try { if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(); } catch (e) {}
            this.ws = null;
            await new Promise(r => setTimeout(r, 300));
        }

        this.updateConnectingUI();

        try {
            this.ws = new WebSocket(this.serverUrl);

            this.ws.onopen = () => {
                const avatarToSend = this.getSafeAvatar();
                this.send({ type: 'register', userId: this.userId, nickname: this.nickname, avatar: avatarToSend });
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(JSON.parse(event.data));
            };

            this.ws.onerror = (error) => {
                console.error('[WebSocket错误]', error);
                this.updateConnectionUI(false);
                // 【防止"掉了连不上"】onerror 触发后通常会跟 onclose，但保险起见也 scheduleReconnect
                // 并且确保用户 enable 开关已开（避免沉默卡住）
                if (this.shouldAutoReconnect && !this.isConnected) {
                    // 只在 ws 真断了、并且没在 scheduleReconnect 过程中时才补一次
                    if (!this.reconnectTimer) this.scheduleReconnect();
                }
            };

            this.ws.onclose = () => {
                const wasConnected = this.isConnected || this.shouldAutoReconnect;
                this.isConnected = false;
                this.updateConnectionUI(false);
                if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
                if (this.shouldAutoReconnect && wasConnected) {
                    this.scheduleReconnect();
                }
            };
        } catch (error) {
            console.error('连接失败:', error);
            this.updateConnectionUI(false);
            // 【防止"掉了连不上"】之前 alert 阻塞主线程，导致 catch 路径永远不会 scheduleReconnect。
            // 改为 console.error（非阻塞），同时显式 scheduleReconnect 兜底。
            if (this.shouldAutoReconnect) {
                if (!this.reconnectTimer) this.scheduleReconnect();
            }
        }
    }

    disconnect() {
        this.shouldAutoReconnect = false;
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            for (const [groupId, chars] of Object.entries(this.aiCharactersInGroup)) {
                const myChar = chars.find(c => c.ownerUserId === this.userId);
                if (myChar) {
                    const chat = this.chats[groupId];
                    this.send({
                        type: 'ai_character_leave',
                        groupId: groupId,
                        characterId: myChar.characterId,
                        characterName: myChar.originalName,
                        members: chat ? chat.members.filter(m => !m.isAiCharacter || m.ownerUserId !== this.userId).map(m => m.userId) : []
                    });
                }
            }
        }

        if (this.ws) { this.isConnected = false; this.ws.close(); this.ws = null; }
        this.updateConnectionUI(false);
        this.saveSettings();
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    generateOnlineGroupMessageId(groupId, senderId, timestamp = Date.now()) {
        const randomPart = Math.random().toString(36).slice(2, 10);
        return `online_group_${groupId}_${senderId}_${timestamp}_${randomPart}`;
    }

    normalizeOnlineGroupMessageId(data) {
        if (!data) return '';
        if (data.messageId) return data.messageId;
        if (data.clientMessageId) return data.clientMessageId;

        const groupId = data.groupId || data.chatId || '';
        const senderId = data.fromUserId || data.senderUserId || '';
        const fallbackTimestamp = data.timestamp || 0;
        const fallbackContent = String(data.message ?? data.content ?? data.reply_content ?? '').slice(0, 120).trim();

        if (!groupId || !senderId || !fallbackTimestamp || !fallbackContent) {
            return '';
        }

        return `online_group_fallback_${groupId}_${senderId}_${fallbackTimestamp}_${fallbackContent}`;
    }

    hasOnlineGroupMessage(chat, messageId) {
        if (!chat || !messageId || !Array.isArray(chat.history)) return false;
        return chat.history.some(msg => msg && msg.messageId === messageId);
    }

    addOnlineGroupMessage(chatId, message, options = {}) {
        const chat = this.chats[chatId];
        if (!chat || !chat.isGroup || !message) return { added: false, chat: chat || null, message: null, reason: 'invalid_group' };

        if (!Array.isArray(chat.history)) chat.history = [];

        const normalizedMessage = { ...message };
        const timestamp = normalizedMessage.timestamp || Date.now();
        normalizedMessage.timestamp = timestamp;
        normalizedMessage.created_at = normalizedMessage.created_at || timestamp;
        // 【修复排序】标记本机"接收时间"——保证新到的消息永远排末尾，
        // 即使服务端时钟和客户端时钟不一致。
        normalizedMessage._receivedAt = normalizedMessage._receivedAt || Date.now();

        const sourceForId = {
            groupId: chatId,
            fromUserId: normalizedMessage.senderUserId || (normalizedMessage.role === 'user' ? this.userId : 'system'),
            message: normalizedMessage.content,
            timestamp: timestamp,
            messageId: normalizedMessage.messageId,
            clientMessageId: normalizedMessage.clientMessageId
        };
        const messageId = this.normalizeOnlineGroupMessageId(sourceForId) || this.generateOnlineGroupMessageId(chatId, sourceForId.fromUserId || 'system', timestamp);
        normalizedMessage.messageId = messageId;
        normalizedMessage.clientMessageId = normalizedMessage.clientMessageId || messageId;

        if (this.hasOnlineGroupMessage(chat, messageId)) {
            // 【BUG 修复】之前 dedup 命中就 return，导致本地副本的 created_at 一直是
            // 用户本地时钟（"sendCurrentMessage" 当时 Date.now()），而服务端 echo 带
            // 的 created_at 是服务端时钟——两端时钟不一致时，本地消息被排错位置
            // （用户的最新消息出现在中间）。
            // 修法：dedup 命中时，如果新消息带 created_at 是服务端时间，
            // 就**更新**本地副本的 created_at，再重排序 + 重新渲染。
            const existing = chat.history.find(m => m && m.messageId === messageId);
            if (existing && normalizedMessage.created_at && existing.created_at !== normalizedMessage.created_at) {
                existing.created_at = normalizedMessage.created_at;
                chat.history.sort(this._sortByTime);
                this.saveChats();
                if (this.activeChatId === chatId) {
                    this.renderMessages(chat, true);
                }
                console.log('[群聊] 重复消息已对齐服务端 created_at:', messageId);
            } else {
                console.log('[群聊] 忽略重复群消息:', messageId);
            }
            return { added: false, chat, message: normalizedMessage, reason: 'duplicate' };
        }

        chat.history.push(normalizedMessage);

        // 排序：用 _sortByTime（优先 _receivedAt，回退 created_at/timestamp）。
        // 不再用"timestamp 升序"——客户端/服务端时钟不一致会导致本地最新消息排中间。
        chat.history.sort(this._sortByTime);

        if (options.updateLastMessage !== false) {
            const STICKER_RE = /(^https:\/\/i\.postimg\.cc\/.+|^https:\/\/files\.catbox\.moe\/.+|^https?:\/\/sharkpan\.xyz\/.+|^data:image|\.(png|jpg|jpeg|gif|webp)\?.*$|\.(png|jpg|jpeg|gif|webp)$)/i;
            const displayContent = STICKER_RE.test(normalizedMessage.content || '') ? '[表情包]' : (normalizedMessage.content || '');
            if (normalizedMessage.role === 'system') {
                chat.lastMessage = displayContent;
            } else {
                const senderName = normalizedMessage.senderNickname || (normalizedMessage.role === 'user' ? this.nickname : '');
                chat.lastMessage = senderName ? `${senderName}: ${displayContent}` : displayContent;
            }
            chat.timestamp = normalizedMessage.created_at || normalizedMessage.timestamp || Date.now();
        }

        if (options.incrementUnread && this.activeChatId !== chatId) {
            chat.unread = (chat.unread || 0) + 1;
        }

        this.saveChats();

        // 【核心修复】之前每条消息都 renderMessages 全量重建 300+ DOM 节点，
        // 手机被卡 → 用户看到"消息全部没了等半天"。
        // 新策略：只在新消息 timestamp 小于最后一条（乱序插入需要重排）时才全量渲染；
        // 否则直接 appendMessageToUI 追加，新消息立即可见，DOM 不重建。
        if (this.activeChatId === chatId && options.render !== false) {
            const lastHistoryMsg = chat.history[chat.history.length - 2];   // 倒数第二 = 排序前的最后
            // 因为 push 后 sort，最后一条是 normalizedMessage 自己
            // 乱序判断：用 _receivedAt（客户端接收时间）——客户端时钟就是权威，
            // 即使服务端消息 created_at 异常也能正确判断"是不是按本机接收顺序追加"。
            const isOutOfOrder = lastHistoryMsg && (
                (normalizedMessage._receivedAt || normalizedMessage.created_at || normalizedMessage.timestamp || 0)
                < (lastHistoryMsg._receivedAt || lastHistoryMsg.created_at || lastHistoryMsg.timestamp || 0)
            );
            if (isOutOfOrder) {
                this.renderMessages(chat, true);   // 乱序，force 全量重排
            } else {
                this.appendMessageToUI(normalizedMessage, chat, true);   // 追加
            }
        }

        if (options.renderChatList !== false) {
            this.renderChatList();
        }

        return { added: true, chat, message: normalizedMessage };
    }

    handleMessage(data) {
        switch (data.type) {
            case 'register_success': this.onRegisterSuccess(); break;
            case 'register_error': this.onRegisterError(data.error); break;
            case 'search_result': this.onSearchResult(data); break;
            case 'friend_request': this.onFriendRequest(data); break;
            case 'friend_request_accepted': this.onFriendRequestAccepted(data); break;
            case 'friend_request_rejected': this.onFriendRequestRejected(data); break;
            case 'receive_message': this.onReceiveMessage(data); break;
            case 'receive_group_message': this.onReceiveGroupMessage(data); break;
            case 'receive_group_created': this.onReceiveGroupMessage(data); break;
            case 'group_history': this.onReceiveGroupHistory(data); break;
            case 'my_groups': this.onReceiveMyGroups(data); break;
            case 'member_removed': this.onMemberRemoved(data); break;
            case 'group_members_added': this.onGroupMembersAdded(data); break;
            case 'group_error': this.onGroupError(data); break;
            case 'ai_character_join': this.onAiCharacterJoin(data); break;
            case 'ai_character_leave': this.onAiCharacterLeave(data); break;
            case 'heartbeat_ack':
                this.heartbeatMissed = 0;
                this.lastHeartbeatTime = Date.now();
                break;
            default: console.warn('未知消息类型:', data.type, data);
        }
    }

    onRegisterSuccess() {
        this.isConnected = true;
        this.shouldAutoReconnect = true;
        this.reconnectAttempts = 0;
        this.heartbeatMissed = 0;
        // 【修复断线循环 bug】之前没在这里初始化 lastHeartbeatTime，导致 setInterval
        // 第一次触发时 sinceLastAck = Date.now() - (null || 0) = 巨大 → 立即 ws.close()，
        // 然后 scheduleReconnect 1s 后重连，又触发同样的链路——表现为每 25s 自动断线重连。
        this.lastHeartbeatTime = Date.now();
        this.updateConnectionUI(true);
        this.startHeartbeat();
        this.saveSettings();

        // 重连成功后立即拉取群聊列表；增量历史补差走 requestCurrentGroupHistory
        // （它会带 sinceMessageId，让服务端只返回本地缺的部分）。
        this.send({ type: 'get_my_groups' });

        // 【群聊补差】只有 _needsResync=true 才走补差；正常情况下本地的就是最新的，
        // 不要无脑拉。补差完成后清掉标记，避免后续 register_success 重复触发。
        if (this._needsResync) {
            this.requestCurrentGroupHistory('register_resync');
            this._needsResync = false;
        }

        this.renderChatList();

        console.log('[连接APP] 注册成功', this._needsResync === false ? '（本地已有最新，跳过历史补差）' : '（增量补差历史）');
    }

    onRegisterError(error) {
        this.updateConnectionUI(false);
        alert('注册失败: ' + error);
    }

    searchFriend() {
        const modal = document.getElementById('search-friend-modal');
        if (modal) {
            const resultDiv = document.getElementById('online-app-search-result');
            if (resultDiv) resultDiv.innerHTML = '<div style="text-align:center;color:#999;padding:30px 20px;">输入对方的ID进行搜索</div>';
            const input = document.getElementById('online-app-search-id');
            if (input) input.value = '';
            modal.classList.add('visible');
        }
    }

    doSearch() {
        const input = document.getElementById('online-app-search-id');
        const searchId = input?.value.trim();
        if (!searchId) { alert('请输入要搜索的好友ID'); return; }
        if (!this.isConnected) { alert('请先连接服务器'); return; }
        const resultDiv = document.getElementById('online-app-search-result');
        if (resultDiv) resultDiv.innerHTML = '<div style="text-align:center;color:#999;padding:30px 20px;">搜索中...</div>';
        console.log('[搜索好友] 发送搜索请求, searchId:', JSON.stringify(searchId), ', 我的ID:', JSON.stringify(this.userId));
        this.send({ type: 'search_user', searchId });
        this._searchTimeout = setTimeout(() => {
            if (resultDiv && resultDiv.innerHTML.includes('搜索中')) {
                resultDiv.innerHTML = '<div style="text-align:center;color:#ff3b30;padding:30px 20px;">搜索超时，服务器未响应。<br>请检查服务器是否支持搜索功能。</div>';
            }
        }, 5000);
    }

    onSearchResult(data) {
        if (this._searchTimeout) { clearTimeout(this._searchTimeout); this._searchTimeout = null; }
        console.log('[搜索好友] 收到搜索结果:', JSON.stringify(data));
        const resultDiv = document.getElementById('online-app-search-result');
        if (!resultDiv) return;

        if (data.found && data.user) {
            const u = data.user;
            const safeNickname = this.escapeHtml(u.nickname || '未知');
            const safeUserId = this.escapeHtml(u.userId || '');
            const safeAvatar = u.avatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
            resultDiv.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid #eee;">
                    <img src="${safeAvatar}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;">
                    <div style="flex:1;">
                        <div style="font-weight:bold;">${safeNickname}</div>
                        <div style="font-size:12px;color:#999;">ID: ${safeUserId}</div>
                    </div>
                    <button onclick="onlineChatManager.sendFriendRequest('${safeUserId.replace(/'/g, "\\'")}','${safeNickname.replace(/'/g, "\\'")}','${safeAvatar.replace(/'/g, "\\'")}')" 
                            style="padding:5px 12px;background:#34c759;color:white;border:none;border-radius:6px;cursor:pointer;">添加好友</button>
                </div>`;
        } else {
            resultDiv.innerHTML = '<div style="text-align:center;color:#999;padding:30px 20px;">未找到该用户，请确认对方已连接服务器</div>';
        }
    }

    sendFriendRequest(friendId) {
        if (!this.isConnected) { alert('未连接到服务器'); return; }
        if (friendId === this.userId) { alert('不能添加自己为好友'); return; }
        if (this.onlineFriends.some(f => f.userId === friendId)) { alert('已经是好友了'); return; }
        this.send({
            type: 'friend_request',
            fromUserId: this.userId,
            fromNickname: this.nickname,
            fromAvatar: this.getSafeAvatar(),
            toUserId: friendId
        });
        alert('好友申请已发送');
        const modal = document.getElementById('search-friend-modal');
        if (modal) modal.classList.remove('visible');
    }

    onFriendRequest(data) {
        this.friendRequests.push({
            fromUserId: data.fromUserId,
            fromNickname: data.fromNickname,
            fromAvatar: data.fromAvatar,
            timestamp: Date.now()
        });
        this.saveFriendRequests();
        this.updateFriendRequestBadge();
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            try {
                navigator.serviceWorker.controller.postMessage({
                    type: 'SHOW_NOTIFICATION',
                    title: '新的好友申请',
                    options: { body: `${data.fromNickname} 请求添加你为好友`, tag: 'friend-req-' + Date.now() }
                });
            } catch (e) {}
        }
    }

    openFriendRequestsModal() {
        const modal = document.getElementById('friend-requests-modal');
        const list = document.getElementById('friend-requests-list');
        if (!modal || !list) return;

        if (this.friendRequests.length === 0) {
            list.innerHTML = '<div style="text-align:center;color:#999;padding:40px 20px;">暂无好友申请</div>';
        } else {
            list.innerHTML = this.friendRequests.map((req, i) => `
                <div style="display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid #eee;">
                    <img src="${req.fromAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;">
                    <div style="flex:1;">
                        <div style="font-weight:bold;">${req.fromNickname}</div>
                        <div style="font-size:12px;color:#999;">ID: ${req.fromUserId}</div>
                    </div>
                    <button onclick="onlineChatManager.acceptFriendRequest(${i})" style="padding:5px 12px;background:#34c759;color:white;border:none;border-radius:6px;cursor:pointer;">接受</button>
                    <button onclick="onlineChatManager.rejectFriendRequest(${i})" style="padding:5px 12px;background:#ff3b30;color:white;border:none;border-radius:6px;cursor:pointer;">拒绝</button>
                </div>
            `).join('');
        }
        modal.classList.add('visible');
    }

    async acceptFriendRequest(index) {
        const req = this.friendRequests[index];
        if (!req) return;

        const friend = {
            userId: req.fromUserId,
            nickname: req.fromNickname,
            avatar: req.fromAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'
        };

        if (!this.onlineFriends.some(f => f.userId === friend.userId)) {
            this.onlineFriends.push(friend);
            this.saveOnlineFriends();
        }

        this.send({
            type: 'accept_friend_request',
            fromUserId: req.fromUserId,
            toUserId: this.userId,
            toNickname: this.nickname,
            toAvatar: this.getSafeAvatar()
        });

        this.addFriendChat(friend);

        this.friendRequests.splice(index, 1);
        this.saveFriendRequests();
        this.updateFriendRequestBadge();
        this.openFriendRequestsModal();
        this.renderChatList();
    }

    rejectFriendRequest(index) {
        const req = this.friendRequests[index];
        if (!req) return;
        this.send({ type: 'reject_friend_request', fromUserId: req.fromUserId, toUserId: this.userId });
        this.friendRequests.splice(index, 1);
        this.saveFriendRequests();
        this.updateFriendRequestBadge();
        this.openFriendRequestsModal();
    }

    async onFriendRequestAccepted(data) {
        const friend = {
            userId: data.fromUserId,
            nickname: data.fromNickname,
            avatar: data.fromAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'
        };
        if (!this.onlineFriends.some(f => f.userId === friend.userId)) {
            this.onlineFriends.push(friend);
            this.saveOnlineFriends();
        }
        this.addFriendChat(friend);
        this.renderChatList();
        alert(`${friend.nickname} 已接受你的好友申请！`);
    }

    onFriendRequestRejected() {
        alert('好友申请被拒绝');
    }

    updateFriendRequestBadge() {
        const badge = document.getElementById('online-app-friend-badge');
        if (badge) {
            if (this.friendRequests.length > 0) {
                badge.textContent = this.friendRequests.length;
                badge.style.display = 'inline';
            } else {
                badge.style.display = 'none';
            }
        }
    }

    addFriendChat(friend) {
        const chatId = `online_${friend.userId}`;
        if (!this.chats[chatId]) {
            this.chats[chatId] = {
                id: chatId,
                name: friend.nickname,
                avatar: friend.avatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
                lastMessage: '已添加为联机好友',
                timestamp: Date.now(),
                unread: 0,
                isGroup: false,
                history: [{ role: 'system', content: '你们已成为联机好友，现在可以开始聊天了！', timestamp: Date.now() }]
            };
        } else {
            this.chats[chatId].name = friend.nickname;
            this.chats[chatId].avatar = friend.avatar || this.chats[chatId].avatar;
        }
        this.saveChats();
    }

    sendCurrentMessage() {
        const input = document.getElementById('online-app-chat-input');
        const content = input?.value.trim();
        if (!content || !this.activeChatId) return;

        if (!this.isConnected) {
            alert('未连接到服务器，无法发送消息');
            return;
        }

        const chat = this.chats[this.activeChatId];
        if (!chat) return;

        const timestamp = Date.now();
        const messageId = chat.isGroup ? this.generateOnlineGroupMessageId(chat.id, this.userId, timestamp) : null;

        if (chat.isGroup) {
            this.send({
                type: 'send_group_message',
                groupId: chat.id,
                members: chat.members.filter(m => !m.isAiCharacter).map(m => m.userId),
                fromUserId: this.userId,
                fromNickname: this.nickname,
                fromAvatar: this.getSafeAvatar(),
                message: content,
                timestamp: timestamp,
                messageId: messageId,
                clientMessageId: messageId
            });
        } else {
            const friendUserId = this.activeChatId.replace('online_', '');
            this.send({
                type: 'send_message',
                toUserId: friendUserId,
                fromUserId: this.userId,
                message: content,
                timestamp: Date.now()
            });
        }

        const msg = {
            role: 'user',
            content: content,
            timestamp: timestamp
        };
        if (messageId) {
            msg.messageId = messageId;
            msg.clientMessageId = messageId;
        }

        if (chat.isGroup) {
            this.addOnlineGroupMessage(chat.id, msg, { render: true, renderChatList: true });
            // 触发联机群聊自动记忆总结
            this.triggerOnlineGroupSummary(chat.id);
        } else {
            if (!Array.isArray(chat.history)) chat.history = [];
            chat.history.push(msg);
            chat.lastMessage = content;
            chat.timestamp = Date.now();
            this.saveChats();
            this.appendMessageToUI(msg, chat);
        }

        input.value = '';
        input.style.height = 'auto';
        input.focus();
    }

    async onReceiveMessage(data) {
        const chatId = `online_${data.fromUserId}`;
        let chat = this.chats[chatId];

        if (!chat) {
            const friend = this.onlineFriends.find(f => f.userId === data.fromUserId);
            chat = {
                id: chatId,
                name: friend ? friend.nickname : '联机好友',
                avatar: friend ? friend.avatar : 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
                lastMessage: data.message,
                timestamp: data.timestamp,
                unread: 0,
                isGroup: false,
                history: []
            };
            this.chats[chatId] = chat;
        }

        if (!Array.isArray(chat.history)) chat.history = [];

        const STICKER_RE = /(^https:\/\/i\.postimg\.cc\/.+|^https:\/\/files\.catbox\.moe\/.+|^https?:\/\/sharkpan\.xyz\/.+|^data:image|\.(png|jpg|jpeg|gif|webp)\?.*$|\.(png|jpg|jpeg|gif|webp)$)/i;
        const isSticker = STICKER_RE.test(data.message);
        const displayMsg = isSticker ? '[表情包]' : data.message;

        const msg = { role: 'ai', content: data.message, timestamp: data.timestamp, stickerName: data.stickerName, stickerMeaning: data.stickerMeaning };
        chat.history.push(msg);
        chat.lastMessage = displayMsg;
        chat.timestamp = data.timestamp;

        if (this.activeChatId !== chatId) {
            chat.unread = (chat.unread || 0) + 1;
        }

        this.saveChats();

        if (this.activeChatId === chatId) {
            this.appendMessageToUI(msg, chat);
        }

        this.renderChatList();
        this.sendNotification(chat.name, data.message, chatId);
    }

    sendNotification(title, body, chatId) {
        const isPageHidden = document.hidden || document.visibilityState === 'hidden';
        const isNotInChat = this.activeChatId !== chatId;
        if (!isPageHidden && !isNotInChat) return;

        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            try {
                navigator.serviceWorker.controller.postMessage({
                    type: 'SHOW_NOTIFICATION',
                    title: title,
                    options: {
                        body: body,
                        icon: 'https://i.postimg.cc/nMbyyt1t/D7CD735A73F5FD1D7B8407E0EB8BBAC0.png',
                        tag: `online-${chatId}-${Date.now()}`,
                        requireInteraction: true,
                        renotify: true,
                        vibrate: [200, 100, 200]
                    }
                });
            } catch (e) {
                if (window.notificationManager) window.notificationManager.notifyNewMessage(title, body, chatId);
            }
        } else if (window.notificationManager) {
            window.notificationManager.notifyNewMessage(title, body, chatId);
        }
    }

    renderChatList() {
        const listEl = document.getElementById('online-app-chat-list');
        if (!listEl) return;

        const allChats = Object.values(this.chats).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        // 【性能优化 + 守卫】之前每次 renderChatList 都全量重建 + appendChild，
        // 几十个群 + 头像 <img> decode → 主线程被卡死 → 白屏闪退。
        // 现在：
        //   1) DocumentFragment 批量插入（单次 reflow）
        //   2) hash 守卫：聊天列表结构没变就跳过整个 rebuild
        //   3) 头像 <img> 加 loading="lazy" + decoding="async" 防止同步 decode 阻塞
        const listHash = allChats.map(c =>
            `${c.id}|${c.unread || 0}|${c.lastMessage || ''}|${(c.timestamp || 0)}|${c.name || ''}`
        ).join('||');
        if (listHash === this._lastRenderedChatListHash) {
            return;   // 结构没变，跳过
        }
        this._lastRenderedChatListHash = listHash;

        if (allChats.length === 0) {
            listEl.innerHTML = `<div class="online-app-empty-hint">
                <p>暂无联机好友</p>
                <p style="font-size:12px;color:#999;">点击右上角 ⚙ 配置联机，点击 + 添加好友</p>
            </div>`;
            return;
        }

        const fragment = document.createDocumentFragment();
        allChats.forEach(chat => {
            const item = document.createElement('div');
            item.className = 'online-chat-list-item';
            item.dataset.chatId = chat.id;

            const avatar = chat.avatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
            const lastMsg = chat.lastMessage || '...';
            const unread = chat.unread || 0;

            let avatarHtml;
            if (chat.isGroup && chat.members && chat.members.length > 0) {
                const showMembers = chat.members.slice(0, 4);
                const avatarImgs = showMembers.map(m =>
                    // 【白屏杀手 1】头像 decode 是同步重操作——加 loading="lazy" + decoding="async"
                    // 让浏览器异步解码，避免一次性同步处理几十张 base64 头像触发白屏
                    `<img src="${m.avatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'}" loading="lazy" decoding="async" onerror="this.src='https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'">`
                ).join('');
                avatarHtml = `<div class="avatar-group group-avatar-grid grid-${showMembers.length}">${avatarImgs}</div>`;
            } else {
                avatarHtml = `<div class="avatar-group"><img src="${avatar}" class="avatar" loading="lazy" decoding="async" onerror="this.src='https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'"></div>`;
            }

            item.innerHTML = `
                ${avatarHtml}
                <div class="info">
                    <div class="name-line">
                        <span class="name">${chat.name}</span>
                    </div>
                    <div class="last-msg">${lastMsg.substring(0, 30)}</div>
                </div>
                <div class="unread-count-wrapper">
                    <span class="unread-count" style="display:${unread > 0 ? 'inline-flex' : 'none'};">${unread > 99 ? '99+' : unread}</span>
                </div>`;

            item.addEventListener('click', () => this.openChat(chat.id));

            let pressTimer = null;
            item.addEventListener('touchstart', (e) => {
                pressTimer = setTimeout(() => {
                    if (confirm(`删除与「${chat.name}」的对话？`)) {
                        delete this.chats[chat.id];
                        this.saveChats();
                        this.renderChatList();
                    }
                }, 600);
            }, { passive: true });
            item.addEventListener('touchend', () => { if (pressTimer) clearTimeout(pressTimer); });
            item.addEventListener('touchmove', () => { if (pressTimer) clearTimeout(pressTimer); });

            fragment.appendChild(item);
        });
        listEl.innerHTML = '';
        listEl.appendChild(fragment);
    }

    openChat(chatId) {
        const chat = this.chats[chatId];
        if (!chat) return;

        this.activeChatId = chatId;
        chat.unread = 0;
        this.saveChats();

        const titleEl = document.getElementById('online-app-chat-title');
        if (titleEl) titleEl.textContent = chat.name;

        const groupInfoBtn = document.getElementById('online-app-group-info-btn');
        if (groupInfoBtn) groupInfoBtn.style.display = chat.isGroup ? 'inline' : 'none';

        this.updateAiCallButton();
        this.renderMessages(chat);
        // 【群聊】不再在 openChat 时主动拉历史——本地已经有消息就直接展示，避免
        // "退一下聊天框就拉"的体验。只有重连成功（onRegisterSuccess）后才会增量补差。
        this.showView('online-app-chat-view');
    }

renderMessages(chat, force = false) {
        const container = document.getElementById('online-app-messages');
        if (!container) return;

        // 【核心修复】之前无条件 full-clear + full-rebuild，每条新消息 + 每次补差都重建
        // 整个 300+ DOM 节点，手机卡死→用户看到"消息全部没了等半天又才出现"。
        // 现在用守卫判断：
        //   - 同 chat + 最后一条消息没变 → 跳过（DOM 已经是最新）
        //   - 切换 chat / 顺序变了 / 强制刷新 → 全量重建
        const history = chat.history || [];
        const lastMsg = history[history.length - 1];
        const lastMsgId = lastMsg ? (lastMsg.messageId || lastMsg.clientMessageId || `tid:${lastMsg.timestamp}`) : null;

        if (!force
            && this._lastRenderedChatId === chat.id
            && this._lastRenderedLastMsgId
            && lastMsgId
            && this._lastRenderedLastMsgId === lastMsgId) {
            // DOM 已经反映到这个 chat 的最新消息，跳过
            return;
        }

        container.innerHTML = '';

        // 渲染前排序：用 _sortByTime（客户端接收时间序，不被时钟差异坑）。
        // 详见 _sortByTime 注释。
        const sortedHistory = history.slice().sort(this._sortByTime);

        // 【性能优化】用 DocumentFragment 批量插入，避免每条消息触发一次 reflow。
        // 之前 300 条消息 = 300 次 reflow（手机卡死数十秒甚至崩浏览器）；
        // 现在 300 条 = 1 次 reflow（毫秒级）。
        const fragment = document.createDocumentFragment();
        sortedHistory.forEach(msg => {
            const node = this.buildMessageNode(msg, chat);
            if (node) fragment.appendChild(node);
        });
        container.appendChild(fragment);

        // 记录本次渲染的"最远进度"
        this._lastRenderedChatId = chat.id;
        this._lastRenderedLastMsgId = lastMsgId;

        requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
    }

    buildMessageNode(msg, chat) {
        // 拆出单消息 DOM 构造，方便 renderMessages 批量插入 + appendMessageToUI 复用
        const container = document.createElement('div');
        const STICKER_RE = /(^https:\/\/i\.postimg\.cc\/.+|^https:\/\/files\.catbox\.moe\/.+|^https?:\/\/sharkpan\.xyz\/.+|^data:image|\.(png|jpg|jpeg|gif|webp)\?.*$|\.(png|jpg|jpeg|gif|webp)$)/i;

        if (msg.role === 'system') {
            container.className = 'online-msg system';
            container.textContent = msg.content;
            return container;
        }

        container.className = msg.role === 'user' ? 'online-msg-row user' : 'online-msg-row friend';

        let avatarSrc;
        if (msg.role === 'user') {
            avatarSrc = this.getSafeAvatar();
        } else if (chat.isGroup && msg.senderAvatar) {
            avatarSrc = msg.senderAvatar;
        } else {
            avatarSrc = chat.avatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
        }

        const isSticker = STICKER_RE.test(msg.content);
        const contentHtml = isSticker
            ? `<img class="sticker-in-msg" src="${msg.content}">`
            : `<div>${this.escapeHtml(msg.content)}</div>`;

        let senderNameHtml = '';
        if (chat.isGroup && msg.role !== 'user' && msg.senderNickname) {
            senderNameHtml = `<div class="group-msg-sender">${this.escapeHtml(msg.senderNickname)}</div>`;
        }

        const bubbleClass = isSticker ? 'online-msg sticker-bubble' : `online-msg ${msg.role === 'user' ? 'user' : 'friend'}`;
        const bubble = `<div class="${bubbleClass}">
            ${senderNameHtml}
            ${contentHtml}
            <div class="msg-time">${this.formatTime(msg.timestamp)}</div>
        </div>`;

        const avatar = `<img class="online-msg-avatar" src="${avatarSrc}">`;

        if (msg.role === 'user') {
            container.innerHTML = bubble + avatar;
        } else {
            container.innerHTML = avatar + bubble;
        }

        return container;
    }

    appendMessageToUI(msg, chat, scroll = true) {
        const container = document.getElementById('online-app-messages');
        if (!container) return;

        const STICKER_RE = /(^https:\/\/i\.postimg\.cc\/.+|^https:\/\/files\.catbox\.moe\/.+|^https?:\/\/sharkpan\.xyz\/.+|^data:image|\.(png|jpg|jpeg|gif|webp)\?.*$|\.(png|jpg|jpeg|gif|webp)$)/i;

        if (msg.role === 'system') {
            const div = document.createElement('div');
            div.className = 'online-msg system';
            div.textContent = msg.content;
            container.appendChild(div);
        } else {
            const wrapper = document.createElement('div');
            wrapper.className = msg.role === 'user' ? 'online-msg-row user' : 'online-msg-row friend';

            let avatarSrc;
            if (msg.role === 'user') {
                avatarSrc = this.getSafeAvatar();
            } else if (chat.isGroup && msg.senderAvatar) {
                avatarSrc = msg.senderAvatar;
            } else {
                avatarSrc = chat.avatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
            }

            const isSticker = STICKER_RE.test(msg.content);
            const contentHtml = isSticker
                ? `<img class="sticker-in-msg" src="${msg.content}">`
                : `<div>${this.escapeHtml(msg.content)}</div>`;

            let senderNameHtml = '';
            if (chat.isGroup && msg.role !== 'user' && msg.senderNickname) {
                senderNameHtml = `<div class="group-msg-sender">${this.escapeHtml(msg.senderNickname)}</div>`;
            }

            const bubbleClass = isSticker ? 'online-msg sticker-bubble' : `online-msg ${msg.role === 'user' ? 'user' : 'friend'}`;
            const bubble = `<div class="${bubbleClass}">
                ${senderNameHtml}
                ${contentHtml}
                <div class="msg-time">${this.formatTime(msg.timestamp)}</div>
            </div>`;

            const avatar = `<img class="online-msg-avatar" src="${avatarSrc}">`;

            if (msg.role === 'user') {
                wrapper.innerHTML = bubble + avatar;
            } else {
                wrapper.innerHTML = avatar + bubble;
            }

            container.appendChild(wrapper);
        }

        // 【修复 mark 同步】让 renderMessages 守卫知道最新进度，避免下次重复渲染
        if (chat) {
            this._lastRenderedChatId = chat.id;
            this._lastRenderedLastMsgId = msg ? (msg.messageId || msg.clientMessageId || `tid:${msg.timestamp}`) : null;
        }

        if (scroll) {
            requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
        }
    }

    toggleStickerPanel() {
        const panel = document.getElementById('online-sticker-panel');
        if (!panel) return;
        if (panel.style.display === 'none' || !panel.style.display) {
            this.renderStickerPanel();
            panel.style.display = 'flex';
        } else {
            panel.style.display = 'none';
        }
    }

    async renderStickerPanel() {
        const grid = document.getElementById('online-sticker-grid');
        const tabs = document.getElementById('online-sticker-tabs');
        if (!grid || !tabs) return;

        tabs.innerHTML = '';
        const allTab = document.createElement('button');
        allTab.className = 'os-tab' + (this._stickerCat === 'all' || !this._stickerCat ? ' active' : '');
        allTab.textContent = '全部';
        allTab.onclick = () => { this._stickerCat = 'all'; this.renderStickerPanel(); };
        tabs.appendChild(allTab);

        if (typeof db !== 'undefined' && db.stickerCategories) {
            const cats = await db.stickerCategories.toArray();
            cats.forEach(cat => {
                const t = document.createElement('button');
                t.className = 'os-tab' + (this._stickerCat === cat.id ? ' active' : '');
                t.textContent = cat.name;
                t.onclick = () => { this._stickerCat = cat.id; this.renderStickerPanel(); };
                tabs.appendChild(t);
            });
        }

        const uncatTab = document.createElement('button');
        uncatTab.className = 'os-tab' + (this._stickerCat === 'uncategorized' ? ' active' : '');
        uncatTab.textContent = '未分类';
        uncatTab.onclick = () => { this._stickerCat = 'uncategorized'; this.renderStickerPanel(); };
        tabs.appendChild(uncatTab);

        let stickers = (typeof state !== 'undefined' && state.userStickers) ? state.userStickers : [];
        if (this._stickerCat === 'uncategorized') {
            stickers = stickers.filter(s => !s.categoryId);
        } else if (this._stickerCat && this._stickerCat !== 'all') {
            stickers = stickers.filter(s => s.categoryId === this._stickerCat);
        }

        grid.innerHTML = '';
        if (stickers.length === 0) {
            grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#999;padding:30px 0;">暂无表情包<br><span style="font-size:12px;">点击右上角"添加"上传表情</span></div>';
            return;
        }

        stickers.forEach(sticker => {
            const item = document.createElement('div');
            item.className = 'online-sticker-item';
            const img = document.createElement('img');
            img.src = sticker.url;
            img.alt = sticker.name;
            img.style.cssText = 'width:100%;height:100%;object-fit:contain;';
            img.onerror = function () { this.style.display = 'none'; };
            item.appendChild(img);
            const nameEl = document.createElement('div');
            nameEl.className = 'online-sticker-name';
            nameEl.textContent = sticker.name;
            item.appendChild(nameEl);
            item.onclick = () => this.sendSticker(sticker);
            grid.appendChild(item);
        });
    }

    sendSticker(sticker) {
        if (!sticker || !sticker.url) return;
        if (!this.activeChatId) return;
        if (!this.isConnected) { alert('未连接到服务器'); return; }

        const chat = this.chats[this.activeChatId];
        if (!chat) return;

        if (sticker.url.startsWith('data:image/')) {
            alert('这个表情还没上传到图床，暂时无法发送给对方。\n请稍等片刻让图片自动上传完成，或重新添加表情。');
            return;
        }

        const timestamp = Date.now();
        const messageId = chat.isGroup ? this.generateOnlineGroupMessageId(chat.id, this.userId, timestamp) : null;

        if (chat.isGroup) {
            this.send({
                type: 'send_group_message',
                groupId: chat.id,
                members: chat.members.filter(m => !m.isAiCharacter).map(m => m.userId),
                fromUserId: this.userId,
                fromNickname: this.nickname,
                fromAvatar: this.getSafeAvatar(),
                message: sticker.url,
                stickerName: sticker.name,
                stickerMeaning: sticker.name,
                timestamp: timestamp,
                messageId: messageId,
                clientMessageId: messageId
            });
        } else {
            const friendUserId = this.activeChatId.replace('online_', '');
            this.send({
                type: 'send_message',
                toUserId: friendUserId,
                fromUserId: this.userId,
                message: sticker.url,
                stickerName: sticker.name,
                stickerMeaning: sticker.name,
                timestamp: Date.now()
            });
        }

        const msg = { role: 'user', content: sticker.url, timestamp: timestamp };
        if (messageId) {
            msg.messageId = messageId;
            msg.clientMessageId = messageId;
        }
        if (chat.isGroup) {
            this.addOnlineGroupMessage(chat.id, msg, { render: true, renderChatList: true });
        } else {
            if (!Array.isArray(chat.history)) chat.history = [];
            chat.history.push(msg);
            chat.lastMessage = '[表情包]';
            chat.timestamp = Date.now();
            this.saveChats();
            this.appendMessageToUI(msg, chat);
        }

        const panel = document.getElementById('online-sticker-panel');
        if (panel) panel.style.display = 'none';
    }

    async addSticker() {
        const input = document.getElementById('online-sticker-upload-input');
        if (input) input.click();
    }

    async handleStickerUpload(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = async () => {
            const base64Url = reader.result;
            const name = prompt('请为这个表情命名：');
            if (!name || !name.trim()) return;

            const newSticker = {
                id: 'sticker_' + Date.now() + Math.random(),
                url: base64Url,
                name: name.trim(),
                categoryId: (this._stickerCat && this._stickerCat !== 'all') ? this._stickerCat : null
            };

            if (typeof db !== 'undefined' && db.userStickers) {
                const newId = await db.userStickers.add(newSticker);
                newSticker.id = newId;
            }
            if (typeof state !== 'undefined' && state.userStickers) {
                state.userStickers.push(newSticker);
            }

            this.renderStickerPanel();

            if (typeof silentlyUpdateDbUrl === 'function') {
                (async () => {
                    await silentlyUpdateDbUrl(db.userStickers, newSticker.id, 'url', base64Url);
                })();
            }
        };
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatTime(timestamp) {
        if (!timestamp) return '';
        const d = new Date(timestamp);
        return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    }

    startHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        // 【设计哲学】客户端不应该主动断开 ws。TCP / 服务端 P0（30s ping + 60s 没 pong terminate）
        // 负责"半死不活就踢"。我们这里只发心跳，让服务端 keepalive。
        // 这样"偶尔丢包"由 TCP 重传兜底，不会被客户端误判掉线。
        this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.send({ type: 'heartbeat', userId: this.userId });
            }
        }, 25000);
    }

    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

        // 重连策略：1秒 → 3秒 → 5秒，然后保持5秒
        let delay;
        if (this.reconnectAttempts === 0) {
            delay = 1000;
        } else if (this.reconnectAttempts === 1) {
            delay = 3000;
        } else {
            delay = 5000;
        }

        this.reconnectAttempts++;
        console.log(`[连接APP] ${delay / 1000}秒后重连 (第${this.reconnectAttempts}次)`);
        this.reconnectTimer = setTimeout(() => {
            // 【防止"掉了连不上"】之前查 #online-app-enable-switch 元素存在 + checked——
            // 如果元素从 DOM 临时消失（比如 view 切换、DOM 重排），scheduleReconnect 就沉默卡住。
            // 直接信任 shouldAutoReconnect 标志（这是用户首次连接成功后服务端给出的确认）。
            // 用户主动关开关会触发 disconnect() 把 shouldAutoReconnect 设 false——也能正确断。
            if (this.shouldAutoReconnect && !this.isConnected) {
                this.connect();
            }
        }, delay);
    }

    setupVisibilityListener() {
        if (this._onVisibilityChange) {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
        }
        this._onVisibilityChange = () => {
            if (document.hidden) return;

            // 【P1 探活】切回前台时如果 ws 还"看似"活着（readyState=OPEN），主动发一个
            // 应用层 ping 让服务端立刻回 pong；2s 内没回 → ws 实际已死（readyState 还在
            // OPEN 是因为 onclose 延迟），主动 close 触发重连。
            //
            // 【设计哲学】客户端只"检测是否真的掉线"，不发主动探活、不主动关闭。
            // 真掉线判定交给 TCP / 反向代理 / 服务端 P0（30s ping + 60s 没 pong terminate）。
            // 这里只检查 ws.readyState：不是 OPEN 就 reconnect；OPEN 就啥也不动（信任下层）。
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                // ws 已断或未连接——强制重连；connect() 会设 _needsResync=true，
                // onRegisterSuccess 会自动增量补差。
                if (this.shouldAutoReconnect) {
                    const enableSwitch = document.getElementById('online-app-enable-switch');
                    if (enableSwitch && enableSwitch.checked) {
                        const idInput = document.getElementById('online-app-my-id');
                        const serverInput = document.getElementById('online-app-server-url');
                        if (idInput?.value && serverInput?.value) {
                            console.log(`[连接APP] 页面恢复可见，ws 已断（readyState=${ws?.readyState}），重连`);
                            this.connect();
                        }
                    }
                }
                // ws.readyState 是 OPEN：信任下层判定，啥也不做。
            }
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    setupBeforeUnloadListener() {
        window.addEventListener('beforeunload', () => {
            this.saveSettings();
            this.saveChats();
        });
    }

    autoReconnectIfNeeded() {
        if (this.shouldAutoReconnect && !this.isConnected) {
            const enableSwitch = document.getElementById('online-app-enable-switch');
            if (enableSwitch && enableSwitch.checked) {
                const idInput = document.getElementById('online-app-my-id');
                const serverInput = document.getElementById('online-app-server-url');
                if (idInput?.value && serverInput?.value) {
                    console.log('[连接APP] 自动重连...');
                    setTimeout(() => this.connect(), 1000);
                }
            }
        }
    }

    async clearAllOldData() {
        if (!confirm('清理所有旧数据？\n\n将清除缓存的旧头像数据，不会删除好友关系和聊天记录。')) return;

        for (const friend of this.onlineFriends) {
            if (friend.avatar && friend.avatar.startsWith('data:image/') && friend.avatar.length > 50000) {
                friend.avatar = 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
            }
        }
        this.saveOnlineFriends();

        for (const chatId in this.chats) {
            const chat = this.chats[chatId];
            if (chat.avatar && chat.avatar.startsWith('data:image/') && chat.avatar.length > 50000) {
                chat.avatar = 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
            }
        }
        this.saveChats();

        alert('旧数据已清理完成');
        this.renderChatList();
    }

    async resetOnlineData() {
        if (!confirm('⚠️ 重置联机数据\n\n将删除所有联机设置、好友、聊天记录。\n包括你的ID、昵称、头像、服务器地址。\n此操作不可撤销！')) return;

        this.disconnect();

        this.friendRequests = [];
        this.onlineFriends = [];
        this.chats = {};
        this.activeChatId = null;
        this.userId = null;
        this.nickname = null;
        this.avatar = 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
        this.serverUrl = null;

        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.startsWith('online-app-') || key === 'ephone-online-settings')) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));

        const idInput = document.getElementById('online-app-my-id');
        const nickInput = document.getElementById('online-app-my-nickname');
        const serverInput = document.getElementById('online-app-server-url');
        const avatarPreview = document.getElementById('online-app-avatar-preview');
        const enableSwitch = document.getElementById('online-app-enable-switch');
        const detailsDiv = document.getElementById('online-app-settings-details');

        if (idInput) idInput.value = '';
        if (nickInput) nickInput.value = '';
        if (serverInput) serverInput.value = '';
        if (avatarPreview) avatarPreview.src = 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
        if (enableSwitch) enableSwitch.checked = false;
        if (detailsDiv) detailsDiv.style.display = 'none';

        this.updateConnectionUI(false);
        this.renderChatList();
        this.showView('online-app-list-view');
        alert('联机数据已全部重置');
    }

    async deleteFriend(index) {
        const friend = this.onlineFriends[index];
        if (!friend) return;
        if (!confirm(`确定要删除好友「${friend.nickname}」吗？\n聊天记录也会被删除。`)) return;

        const chatId = `online_${friend.userId}`;
        this.onlineFriends.splice(index, 1);
        this.saveOnlineFriends();
        delete this.chats[chatId];
        this.saveChats();

        if (this.activeChatId === chatId) {
            this.activeChatId = null;
            this.showView('online-app-list-view');
        }
        this.renderChatList();
    }

    openCreateGroupModal() {
        if (!this.isConnected) {
            alert('请先连接服务器');
            return;
        }
        if (this.onlineFriends.length === 0) {
            alert('暂无联机好友，请先添加好友');
            return;
        }

        const modal = document.getElementById('create-group-modal');
        const listEl = document.getElementById('create-group-friend-list');
        const nameInput = document.getElementById('group-name-input');
        if (!modal || !listEl) return;

        nameInput.value = '';
        listEl.innerHTML = '';

        this.onlineFriends.forEach((friend, idx) => {
            const item = document.createElement('div');
            item.className = 'create-group-friend-item';
            item.innerHTML = `
                <label style="display:flex;align-items:center;gap:10px;padding:10px 0;cursor:pointer;">
                    <input type="checkbox" class="group-friend-checkbox" data-index="${idx}" value="${friend.userId}">
                    <img src="${friend.avatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'}" 
                         style="width:36px;height:36px;border-radius:50%;object-fit:cover;"
                         onerror="this.src='https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'">
                    <span style="font-size:14px;">${this.escapeHtml(friend.nickname)}</span>
                    <span style="font-size:12px;color:#999;">(${friend.userId})</span>
                </label>`;
            listEl.appendChild(item);
        });

        modal.classList.add('visible');
    }

    confirmCreateGroup() {
        const nameInput = document.getElementById('group-name-input');
        const checkboxes = document.querySelectorAll('.group-friend-checkbox:checked');

        const groupName = nameInput?.value.trim();
        if (!groupName) {
            alert('请输入群名称');
            return;
        }

        const selectedFriends = [];
        checkboxes.forEach(cb => {
            const idx = parseInt(cb.dataset.index, 10);
            const friend = this.onlineFriends[idx];
            if (friend) selectedFriends.push(friend);
        });

        if (selectedFriends.length < 1) {
            alert('请至少选择1个好友');
            return;
        }

        const groupId = `group_${this.userId}_${Date.now()}`;

        const members = [
            { userId: this.userId, nickname: this.nickname, avatar: this.getSafeAvatar() },
            ...selectedFriends.map(f => ({
                userId: f.userId,
                nickname: f.nickname,
                avatar: f.avatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'
            }))
        ];

        this.chats[groupId] = {
            id: groupId,
            name: groupName,
            avatar: null,
            lastMessage: '群聊已创建',
            timestamp: Date.now(),
            unread: 0,
            isGroup: true,
            members: members,
            owner: this.userId,
            history: [{ role: 'system', content: `群聊「${groupName}」已创建，共${members.length}人`, timestamp: Date.now() }]
        };
        this.saveChats();

        this.send({
            type: 'create_group',
            groupId: groupId,
            groupName: groupName,
            members: members,
            creatorId: this.userId
        });

        const modal = document.getElementById('create-group-modal');
        if (modal) modal.classList.remove('visible');

        this.renderChatList();
        this.openChat(groupId);
    }

    openAddGroupMembersModal(groupId = this.activeChatId) {
        const chat = this.chats[groupId];
        if (!chat || !chat.isGroup) return;
        if (!this.isConnected) {
            alert('请先连接服务器');
            return;
        }
        if (chat.owner !== this.userId) {
            alert('只有群主可以拉好友入群');
            return;
        }

        const memberIds = new Set((chat.members || []).filter(m => !m.isAiCharacter).map(m => m.userId));
        const candidates = this.onlineFriends.filter(friend => !memberIds.has(friend.userId));

        if (candidates.length === 0) {
            alert('暂无可拉入群的好友');
            return;
        }

        let modal = document.getElementById('add-group-members-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'add-group-members-modal';
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content" style="max-height:70vh;">
                    <div class="modal-header">
                        <span>拉好友入群</span>
                        <span class="modal-close" onclick="document.getElementById('add-group-members-modal').classList.remove('visible')">✕</span>
                    </div>
                    <div class="modal-body" style="padding:10px 15px;">
                        <div id="add-group-members-list" style="max-height:45vh;overflow-y:auto;"></div>
                        <button class="settings-full-btn" style="margin-top:15px;background:#007aff;" onclick="onlineChatManager.confirmAddGroupMembers()">确认拉入</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
        }

        modal.dataset.groupId = groupId;
        const listEl = document.getElementById('add-group-members-list');
        if (!listEl) return;

        listEl.innerHTML = candidates.map((friend, idx) => `
            <label style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #eee;cursor:pointer;">
                <input type="checkbox" class="add-group-member-checkbox" data-index="${idx}">
                <img src="${friend.avatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'}" 
                     style="width:36px;height:36px;border-radius:50%;object-fit:cover;"
                     onerror="this.src='https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'">
                <div style="flex:1;">
                    <div style="font-size:14px;">${this.escapeHtml(friend.nickname)}</div>
                    <div style="font-size:12px;color:#999;">${friend.userId}</div>
                </div>
            </label>
        `).join('');

        this._addGroupCandidates = candidates;
        modal.classList.add('visible');
    }

    confirmAddGroupMembers() {
        const modal = document.getElementById('add-group-members-modal');
        const groupId = modal?.dataset.groupId;
        const chat = groupId ? this.chats[groupId] : null;
        if (!chat || !chat.isGroup) return;

        const selected = [];
        document.querySelectorAll('.add-group-member-checkbox:checked').forEach(cb => {
            const idx = parseInt(cb.dataset.index, 10);
            const friend = this._addGroupCandidates?.[idx];
            if (friend) {
                selected.push({
                    userId: friend.userId,
                    nickname: friend.nickname,
                    avatar: friend.avatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'
                });
            }
        });

        if (selected.length === 0) {
            alert('请至少选择1个好友');
            return;
        }

        this.send({
            type: 'add_group_members',
            groupId: groupId,
            newMembers: selected,
            operatorNickname: this.nickname
        });

        if (modal) modal.classList.remove('visible');
    }

    getCurrentOnlineGroupId() {
        const groupId = this.activeChatId;
        const chat = groupId ? this.chats[groupId] : null;
        if (!chat || !chat.isGroup) return null;
        return groupId;
    }

    requestCurrentGroupHistory(reason = 'current_group') {
        const groupId = this.getCurrentOnlineGroupId();
        if (!groupId) return;
        this.requestGroupHistory(groupId, reason);
    }

    requestGroupHistory(groupId, reason = 'manual') {
        if (!groupId || !this.isConnected) return;
        const chat = this.chats[groupId];
        if (!chat || !chat.isGroup) return;

        const now = Date.now();
        const lastPullAt = this.lastGroupHistoryPullAt[groupId] || 0;
        if (now - lastPullAt < this.groupHistoryPullDebounceMs) {
            console.log('[群聊] 跳过重复历史补拉:', groupId, reason);
            return;
        }

        // 【增量补差】取出本地最后一条消息的 messageId，让服务端只返回更新的部分。
        // 本地没记录就传 null，服务端会返回完整历史。
        const historyArr = Array.isArray(chat.history) ? chat.history : [];
        let sinceMessageId = null;
        if (historyArr.length > 0) {
            // 找最后一条有 messageId 的消息
            for (let i = historyArr.length - 1; i >= 0; i--) {
                const m = historyArr[i];
                if (m && (m.messageId || m.clientMessageId)) {
                    sinceMessageId = m.messageId || m.clientMessageId;
                    break;
                }
            }
        }

        this.lastGroupHistoryPullAt[groupId] = now;
        console.log('[群聊] 请求历史补差:', groupId, reason, sinceMessageId ? `(since=${sinceMessageId})` : '(全量)');
        this.send({
            type: 'get_group_history',
            groupId: groupId,
            sinceMessageId: sinceMessageId
        });
    }

    onReceiveGroupHistory(data) {
        const groupId = data.groupId;
        const chat = this.chats[groupId];
        if (!chat || !chat.isGroup) return;

        const historyMessages = Array.isArray(data.messages) ? data.messages : [];

        // 【群聊补差 - 合并而非覆盖】
        // 之前逻辑：chat.history = [] 直接清空本地，然后用服务端 history 填回去——
        // 后果是本地刚发的、服务端只存 300 条以外的、客户端时钟领先服务端的"未来消息"全没了。
        // 现在改为 merge：服务端返回的 historyMessages 是增量（带 sinceMessageId 拉的），
        // 用 _mergeHistory 按 messageId 去重合并，本地消息永远不会被服务端覆盖丢失。
        if (!Array.isArray(chat.history)) chat.history = [];

        if (historyMessages.length === 0) {
            console.log(`[群聊] 群 ${groupId} 无新增历史，跳过合并`);
            return;
        }

        const normalizedIncoming = historyMessages.map(item => {
            const messageId = this.normalizeOnlineGroupMessageId(item);
            const isMine = item.fromUserId === this.userId;
            return {
                role: isMine ? 'user' : 'ai',
                content: item.message,
                timestamp: item.timestamp || item.created_at || Date.now(),
                created_at: item.created_at || item.timestamp || Date.now(),
                // 【修复排序】标记本机"接收时间"——保证服务端补差消息按本机时间排，
                // 即使服务端时钟和客户端时钟不一致。
                _receivedAt: Date.now(),
                senderUserId: item.fromUserId,
                senderNickname: item.fromNickname,
                senderAvatar: item.fromAvatar,
                isAiCharacter: item.isAiCharacter || false,
                messageId: messageId,
                clientMessageId: item.clientMessageId || messageId,
                stickerName: item.stickerName,
                stickerMeaning: item.stickerMeaning
            };
        });

        const beforeMergeCount = chat.history.length;
        this._mergeHistory(chat, { history: normalizedIncoming });
        const afterMergeCount = chat.history.length;

        // 排序兜底（_mergeHistory 内部已经排了，但防御性再来一次）
        chat.history.sort(this._sortByTime);

        // 只在新增了消息时更新 lastMessage（避免服务端返回老消息把会话列表最后一条"回退"）
        if (afterMergeCount > beforeMergeCount) {
            const lastMsg = chat.history[chat.history.length - 1];
            const STICKER_RE = /(^https:\/\/i\.postimg\.cc\/.+|^https:\/\/files\.catbox\.moe\/.+|^https?:\/\/sharkpan\.xyz\/.+|^data:image|\.(png|jpg|jpeg|gif|webp)\?.*$|\.(png|jpg|jpeg|gif|webp)$)/i;
            const isSticker = STICKER_RE.test(lastMsg.content || '');
            const displayContent = isSticker ? '[表情包]' : (lastMsg.content || '');

            if (lastMsg.role === 'system') {
                chat.lastMessage = displayContent;
            } else {
                const senderName = lastMsg.senderNickname || (lastMsg.role === 'user' ? this.nickname : '');
                chat.lastMessage = senderName ? `${senderName}: ${displayContent}` : displayContent;
            }
            chat.timestamp = lastMsg.timestamp || lastMsg.created_at || Date.now();
        }

        this.saveChats();

        const added = afterMergeCount - beforeMergeCount;

        // 【修复视觉闪烁】之前无条件 renderMessages，导致 merge dedup 命中时也清空 DOM
        // 重建——视觉上像"聊天记录被全清再重拉"。现在只有真正新增了消息才重渲染。
        // 注：addOnlineGroupMessage 的 dedup 命中分支已经处理"created_at 对齐"的 case。
        if (this.activeChatId === groupId && added > 0) {
            this.renderMessages(chat);
        }

        this.renderChatList();

        console.log(`[群聊] 群 ${groupId} 历史已合并，新增 ${added} 条，共 ${chat.history.length} 条`);
    }

    onReceiveGroupMessage(data) {
        console.log('[群聊] 收到群消息:', data.type, data.groupId, data);
        const chatId = data.groupId;
        let chat = this.chats[chatId];

        if (data.type === 'receive_group_created') {
            if (!chat) {
                chat = {
                    id: chatId,
                    name: data.groupName,
                    avatar: null,
                    lastMessage: '你被邀请加入群聊',
                    timestamp: data.timestamp || Date.now(),
                    unread: 1,
                    isGroup: true,
                    members: data.members || [],
                    owner: data.owner || data.creatorId || '',
                    history: [{ role: 'system', content: `你被邀请加入群聊「${data.groupName}」`, timestamp: Date.now() }]
                };
                this.chats[chatId] = chat;
            } else {
                chat.name = data.groupName || chat.name;
                chat.members = data.members || chat.members || [];
                chat.owner = data.owner || data.creatorId || chat.owner || '';
                // 【群聊自愈】服务端把这个群同步过来了 → 群主已经重建过 → 清掉自愈标记
                delete chat._serverResyncing;
                delete chat._serverLostWarned;
            }
            this.saveChats();
            this.renderChatList();
            return;
        }

        if (!chat) return;

        const messageId = this.normalizeOnlineGroupMessageId(data);
        const STICKER_RE = /(^https:\/\/i\.postimg\.cc\/.+|^https:\/\/files\.catbox\.moe\/.+|^https?:\/\/sharkpan\.xyz\/.+|^data:image|\.(png|jpg|jpeg|gif|webp)\?.*$|\.(png|jpg|jpeg|gif|webp)$)/i;
        const isSticker = STICKER_RE.test(data.message);
        const displayMsg = isSticker ? '[表情包]' : data.message;

        const msg = {
            role: 'ai',
            content: data.message,
            timestamp: data.timestamp,
            senderUserId: data.fromUserId,
            senderNickname: data.fromNickname,
            senderAvatar: data.fromAvatar,
            messageId: messageId,
            clientMessageId: data.clientMessageId || messageId,
            stickerName: data.stickerName,
            stickerMeaning: data.stickerMeaning
        };

        const result = this.addOnlineGroupMessage(chatId, msg, { incrementUnread: true, render: true, renderChatList: true });
        if (!result.added) return;

        this.sendNotification(chat.name, `${data.fromNickname}: ${displayMsg}`, chatId);

        // 触发联机群聊自动记忆总结
        this.triggerOnlineGroupSummary(chatId);
    }

    onReceiveMyGroups(data) {
        console.log('[群聊] 收到我的群聊列表:', data.groups);
        if (!data.groups || !Array.isArray(data.groups)) data = { groups: [] };

        const serverGroupIds = new Set();

        data.groups.forEach(group => {
            const chatId = group.id;
            serverGroupIds.add(chatId);
            const restoredHistory = Array.isArray(group.history) ? group.history : [];
            if (!this.chats[chatId]) {
                this.chats[chatId] = {
                    id: chatId,
                    name: group.name,
                    avatar: null,
                    lastMessage: '群聊已恢复',
                    timestamp: group.timestamp || Date.now(),
                    unread: 0,
                    isGroup: true,
                    members: group.members || [],
                    owner: group.owner || '',
                    history: restoredHistory.length > 0 ? restoredHistory : [{ role: 'system', content: `群聊「${group.name}」已恢复`, timestamp: Date.now() }]
                };
            } else {
                this.chats[chatId].members = group.members || [];
                this.chats[chatId].owner = group.owner || '';
                this.chats[chatId].name = group.name || this.chats[chatId].name;
                if (restoredHistory.length > 0) {
                    this._mergeHistory(this.chats[chatId], { history: restoredHistory });
                }
                // 服务端有这个群，说明之前恢复成功了，清掉自愈标记
                delete this.chats[chatId]._serverResyncing;
                delete this.chats[chatId]._serverLostWarned;
            }
        });

        // 【群聊自愈】群主上线时自检：本地有但服务端没返回的群，自动重建
        const localGroupIds = Object.keys(this.chats).filter(id => this.chats[id]?.isGroup);
        const missingGroupIds = localGroupIds.filter(id => !serverGroupIds.has(id));

        if (missingGroupIds.length > 0) {
            const resynced = [];
            for (const groupId of missingGroupIds) {
                const chat = this.chats[groupId];
                if (!chat) continue;
                const isOwner = chat.owner === this.userId;
                if (!isOwner) continue;  // 非群主不能重建，跳过

                if (chat._serverResyncing) {
                    console.log('[联机群聊] 已在自愈中，跳过:', groupId);
                    continue;
                }

                console.log('[联机群聊] 服务端缺这个群，群主自动重建:', groupId, chat.name);
                chat._serverResyncing = true;
                this.send({
                    type: 'create_group',
                    groupId: groupId,
                    groupName: chat.name,
                    members: chat.members || [],
                    creatorId: this.userId
                });
                resynced.push(chat.name);
            }
            if (resynced.length > 0) {
                // 延迟 1.5 秒弹一个合并提示，避免连续多个 alert
                if (this._serverResyncToastTimer) clearTimeout(this._serverResyncToastTimer);
                this._serverResyncToastTimer = setTimeout(() => {
                    alert(
                        resynced.length === 1
                            ? `已自动恢复群聊数据：「${resynced[0]}」\n\n（服务端之前丢了群聊数据，已用本地缓存重建）`
                            : `已自动恢复 ${resynced.length} 个群聊数据：\n${resynced.map(n => '• ' + n).join('\n')}\n\n（服务端之前丢了群聊数据，已用本地缓存重建）`
                    );
                    this._serverResyncToastTimer = null;
                }, 1500);
            }
        }

        this.saveChats();
        this.renderChatList();
    }

    onMemberRemoved(data) {
        const chat = this.chats[data.groupId];
        if (!chat) return;

        const removedMember = (chat.members || []).find(m => m.userId === data.memberUserId);
        chat.members = (data.members || chat.members || []).filter(m => m.userId !== data.memberUserId);
        if (data.owner) chat.owner = data.owner;

        if (data.memberUserId === this.userId) {
            // 被移除：显示通知
            const groupName = data.groupName || chat.name || '群聊';
            alert(`你被移出了群「${groupName}」`);

            delete this.chats[data.groupId];
            if (this.activeChatId === data.groupId) {
                this.activeChatId = null;
                this.showView('online-app-list-view');
            }
        } else if (removedMember) {
            this.addOnlineGroupMessage(data.groupId, {
                role: 'system',
                content: `${removedMember.nickname} 被移除出群聊`,
                timestamp: Date.now()
            }, { render: true, renderChatList: false });
        }

        this.saveChats();
        this.renderChatList();
    }

    onGroupMembersAdded(data) {
        const chat = this.chats[data.groupId];

        // 检查是否是新加入的成员（之前不在群里）
        const isNewMember = !chat && data.addedMembers && data.addedMembers.some(m => m.userId === this.userId);

        if (isNewMember) {
            // 被拉入新群或重新拉入之前被移除的群：刷新群列表
            console.log('[群聊] 被拉入群聊，刷新群列表');
            this.send({ type: 'get_my_groups' });

            // 显示通知
            const groupName = data.groupName || '群聊';
            alert(`你被拉入了群「${groupName}」`);
            return;
        }

        if (!chat) return;

        chat.members = data.members || chat.members || [];
        if (data.owner) chat.owner = data.owner;
        if (data.groupName) chat.name = data.groupName;

        const addedMembers = Array.isArray(data.addedMembers) ? data.addedMembers : [];
        if (addedMembers.length > 0) {
            const names = addedMembers.map(m => m.nickname || m.userId).join('、');
            this.addOnlineGroupMessage(data.groupId, {
                role: 'system',
                content: `${data.operatorNickname || '群主'} 拉 ${names} 入群`,
                timestamp: data.timestamp || Date.now()
            }, { render: true, renderChatList: true });
        } else {
            this.saveChats();
            this.renderChatList();
        }
    }

    onGroupError(data) {
        const message = data?.error || '群聊操作失败';
        const groupId = data?.groupId;

        // 【群聊自愈】服务端说"群聊不存在"——尝试自动恢复
        if (message === '群聊不存在' && groupId && this.chats[groupId]?.isGroup) {
            const chat = this.chats[groupId];
            const isOwner = chat.owner === this.userId;

            if (isOwner) {
                // 群主：用本地数据自动重建群聊
                console.log('[联机群聊] 服务端群聊丢失，群主自动重建:', groupId);
                this.send({
                    type: 'create_group',
                    groupId: groupId,
                    groupName: chat.name,
                    members: chat.members || [],
                    creatorId: this.userId
                });
                // 标记一下，避免重复弹提示
                chat._serverResyncing = true;
                return;  // 不弹 alert，悄悄恢复
            }

            // 非群主：弹一次性提示（每个群只弹一次）
            if (!chat._serverLostWarned) {
                chat._serverLostWarned = true;
                const ownerNickname = (chat.members || []).find(m => m.userId === chat.owner)?.nickname || '群主';
                alert(
                    `群聊「${chat.name}」的服务端数据丢失\n\n` +
                    `请让「${ownerNickname}」重新登录一次客户端，` +
                    `群主客户端会自动重建群聊数据。\n\n` +
                    `（重建前本群无法拉历史和拉新人，但发消息不受影响）`
                );
            }
            return;
        }

        alert(message);
    }

    openGroupInfoModal() {
        if (!this.activeChatId) return;
        const chat = this.chats[this.activeChatId];
        if (!chat || !chat.isGroup) return;

        const modal = document.getElementById('group-info-modal');
        const content = document.getElementById('group-info-content');
        if (!modal || !content) return;

        const isOwner = chat.owner === this.userId;
        const membersHtml = (chat.members || []).map(m => {
            const canRemove = isOwner && m.userId !== this.userId && !m.isAiCharacter;
            return `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 0;">
                <img src="${m.avatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'}" 
                     style="width:36px;height:36px;border-radius:50%;object-fit:cover;"
                     onerror="this.src='https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'">
                <div style="flex:1;">
                    <div style="font-size:14px;">${this.escapeHtml(m.nickname)}${chat.owner === m.userId ? ' (群主)' : ''}</div>
                    <div style="font-size:12px;color:#999;">${m.isAiCharacter ? `AI角色 (${m.ownerUserId === this.userId ? '我的' : '其他人的'})` : m.userId}${m.userId === this.userId ? ' (我)' : ''}</div>
                </div>
                ${canRemove ? `<button class="settings-btn" style="color:#ff3b30;font-size:12px;padding:4px 8px;" onclick="onlineChatManager.removeMember('${chat.id}', '${m.userId}')">移除</button>` : ''}
            </div>`;
        }).join('');

        const inviteButtonHtml = isOwner
            ? `<button class="settings-full-btn" style="margin-top:10px;color:#007aff;" onclick="onlineChatManager.openAddGroupMembersModal('${chat.id}')">拉好友入群</button>`
            : '';

        const groupAiChars = this.aiCharactersInGroup[this.activeChatId] || [];
        const myAiChar = groupAiChars.find(c => c.ownerUserId === this.userId);
        const aiButtonHtml = myAiChar
            ? `<button class="settings-full-btn" style="margin-top:10px;color:#ff9500;"
                    onclick="onlineChatManager.removeAiCharacterFromGroup('${chat.id}');closeGroupInfoModal();">移除我的AI角色 (${this.escapeHtml(myAiChar.originalName)})</button>`
            : `<button class="settings-full-btn" style="margin-top:10px;color:#007aff;"
                    onclick="onlineChatManager.openAddAiCharacterModal();closeGroupInfoModal();">拉入AI角色</button>`;

        // 【修复】立即总结按钮：之前只在 myAiChar 存在时显示，导致用户以为"按钮被删了"。
        // 现在无条件显示；如果群还没拉 AI 角色，按钮会提示先去拉角色。
        const summaryButtonHtml = `
            <button class="settings-full-btn" style="margin-top:10px;background:#5856d6;color:white;font-weight:500;"
                    onclick="onlineChatManager.triggerOnlineGroupSummary('${chat.id}', { manual: true });">📝 立即总结记忆</button>
            <div style="font-size:11px;color:#999;margin-top:4px;">
                ${myAiChar
                    ? `调副 API 把当前群里未总结的消息总结成第一人称记忆，写入主屏「${this.escapeHtml(myAiChar.originalName)}」的长期记忆页面`
                    : `当前群还没拉入 AI 角色——拉入后再用此按钮总结（从群信息里"拉入 AI 角色"添加）`}
            </div>
        `;

        // 【导出按钮】导出当前群聊（单群历史 + 成员信息），方便备份 / 分享给朋友
        const exportCurrentGroupHtml = `
            <button class="settings-full-btn" style="margin-top:15px;background:#34c759;color:white;font-weight:500;"
                    onclick="onlineChatManager.exportCurrentGroup('${chat.id}')">📥 导出当前群聊</button>
            <div style="font-size:11px;color:#999;margin-top:4px;">
                把本群所有消息 + 成员信息保存为 JSON 文件（浏览器会触发下载）
            </div>
        `;

        // 【导出按钮】导出全部联机数据（好友 + 全部群聊 + AI 角色），换设备时一键恢复
        const exportAllOnlineDataHtml = `
            <button class="settings-full-btn" style="margin-top:10px;background:#5ac8fa;color:white;font-weight:500;"
                    onclick="onlineChatManager.exportAllOnlineData()">📦 导出全部联机数据</button>
            <div style="font-size:11px;color:#999;margin-top:4px;">
                导出全部好友 + 全部群聊（用于换设备时一键恢复）
            </div>
        `;

        const currentContextSize = chat.aiContextSize || 20;
        const aiContextSettingHtml = `
            <div style="margin-top:15px;padding-top:15px;border-top:1px solid #eee;">
                <div style="font-size:14px;font-weight:600;margin-bottom:10px;">AI角色设置</div>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                    <span style="font-size:13px;color:#666;">AI角色上下文条数</span>
                    <input type="number" id="group-ai-context-size" 
                           value="${currentContextSize}" 
                           min="5" max="100" step="1"
                           style="width:70px;padding:5px;border:1px solid #ddd;border-radius:6px;text-align:center;font-size:13px;">
                </div>
                <div style="font-size:11px;color:#999;margin-top:5px;">
                    控制AI角色能看到的群聊历史消息数量（独立设置，不影响主屏幕）
                </div>
                <button class="settings-full-btn" style="margin-top:10px;background:#34c759;" 
                        onclick="onlineChatManager.saveGroupAiContextSize('${chat.id}')">保存设置</button>
            </div>`;

        content.innerHTML = `
            <div style="padding:15px;">
                <div style="font-size:16px;font-weight:600;margin-bottom:5px;">${this.escapeHtml(chat.name)}</div>
                <div style="font-size:13px;color:#999;margin-bottom:15px;">群成员 (${(chat.members || []).length}人)</div>
                <div>${membersHtml}</div>
                ${inviteButtonHtml}
                ${aiButtonHtml}
                ${aiContextSettingHtml}
                ${summaryButtonHtml}
                ${exportCurrentGroupHtml}
                ${exportAllOnlineDataHtml}
                <button class="settings-full-btn" style="margin-top:15px;color:#ff3b30;"
                        onclick="onlineChatManager.leaveGroup('${chat.id}')">退出群聊</button>
            </div>`;

        modal.classList.add('visible');
    }

    exportCurrentGroup(groupId) {
        const chat = this.chats[groupId];
        if (!chat || !chat.isGroup) {
            alert('找不到这个群聊');
            return;
        }

        const exportData = {
            type: 'online_group_export',
            version: 1,
            exportedAt: Date.now(),
            group: {
                id: chat.id,
                name: chat.name,
                owner: chat.owner,
                members: chat.members || [],
                timestamp: chat.timestamp,
                createdBy: this.userId
            },
            messages: Array.isArray(chat.history) ? chat.history : []
        };

        const filename = `online-group-${this._sanitizeFileName(chat.name)}-${this._formatDateForFile()}.json`;
        this._downloadJson(exportData, filename);
    }

    exportAllOnlineData() {
        if (!confirm('导出全部联机数据？\n\n将导出你的全部好友 + 全部群聊 + AI 角色绑定。\n（不包括你的 ID / 昵称 / 头像等设置，这些跟着浏览器走）')) return;

        const exportData = {
            type: 'online_full_export',
            version: 1,
            exportedAt: Date.now(),
            userId: this.userId,
            nickname: this.nickname,
            chats: this.chats || {},
            onlineFriends: this.onlineFriends || [],
            friendRequests: this.friendRequests || [],
            aiCharactersInGroup: this.aiCharactersInGroup || {}
        };

        const filename = `online-all-data-${this.userId || 'default'}-${this._formatDateForFile()}.json`;
        this._downloadJson(exportData, filename);
    }

    _downloadJson(data, filename) {
        try {
            const json = JSON.stringify(data, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) {
            alert('导出失败: ' + e.message);
        }
    }

    _sanitizeFileName(name) {
        return String(name || 'untitled').replace(/[\\/:*?"<>|]/g, '_').slice(0, 50);
    }

    _formatDateForFile() {
        const d = new Date();
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    }

    leaveGroup(groupId) {
        if (!confirm('确定要退出这个群聊吗？聊天记录将被删除。')) return;

        delete this.chats[groupId];
        this.saveChats();

        if (this.activeChatId === groupId) {
            this.activeChatId = null;
            this.showView('online-app-list-view');
        }

        const modal = document.getElementById('group-info-modal');
        if (modal) modal.classList.remove('visible');

        this.renderChatList();
    }

    removeMember(groupId, memberUserId) {
        if (!confirm('确定要移除这个成员吗？')) return;

        const chat = this.chats[groupId];
        if (!chat || !chat.isGroup || chat.owner !== this.userId) return;

        this.send({
            type: 'remove_group_member',
            groupId: groupId,
            memberUserId: memberUserId
        });

        this.openGroupInfoModal();
    }

    saveGroupAiContextSize(groupId) {
        const input = document.getElementById('group-ai-context-size');
        if (!input) return;

        const value = parseInt(input.value, 10);
        if (isNaN(value) || value < 5 || value > 100) {
            alert('请输入5到100之间的数值');
            return;
        }

        const chat = this.chats[groupId];
        if (!chat) return;

        chat.aiContextSize = value;
        this.saveChats();

        alert('设置已保存！');
    }

    openAddAiCharacterModal() {
        if (!this.activeChatId) return;
        const chat = this.chats[this.activeChatId];
        if (!chat || !chat.isGroup) { alert('只能在群聊中拉入AI角色'); return; }

        const groupAiChars = this.aiCharactersInGroup[this.activeChatId] || [];
        const myExisting = groupAiChars.find(c => c.ownerUserId === this.userId);
        if (myExisting) {
            alert(`你已经拉入了角色「${myExisting.originalName}」，每人只能拉入一个角色`);
            return;
        }

        if (!window.state || !window.state.chats) {
            alert('主屏幕聊天数据未加载，请先打开主屏幕');
            return;
        }

        const mainChats = Object.values(window.state.chats).filter(c => !c.isGroup && c.settings && c.settings.aiPersona);
        if (mainChats.length === 0) {
            alert('主屏幕没有可用的AI角色');
            return;
        }

        let modal = document.getElementById('add-ai-character-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'add-ai-character-modal';
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content" style="max-height:70vh;">
                    <div class="modal-header">
                        <span>选择要拉入的AI角色</span>
                        <span class="modal-close" onclick="document.getElementById('add-ai-character-modal').classList.remove('visible')">✕</span>
                    </div>
                    <div class="modal-body" id="ai-character-select-list" style="overflow-y:auto;max-height:55vh;padding:10px 15px;"></div>
                </div>`;
            document.body.appendChild(modal);
        }

        const listEl = document.getElementById('ai-character-select-list');
        listEl.innerHTML = '';

        mainChats.forEach(c => {
            const avatar = (c.settings && c.settings.aiAvatar) || c.avatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg';
            const item = document.createElement('div');
            item.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid #eee;cursor:pointer;';
            item.innerHTML = `
                <img src="${avatar}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;" onerror="this.src='https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'">
                <div style="flex:1;">
                    <div style="font-weight:bold;">${this.escapeHtml(c.originalName || c.name)}</div>
                    <div style="font-size:12px;color:#999;">${this.escapeHtml((c.settings.aiPersona || '').substring(0, 50))}...</div>
                </div>`;
            item.addEventListener('click', () => {
                this.addAiCharacterToGroup(c);
                modal.classList.remove('visible');
            });
            listEl.appendChild(item);
        });

        modal.classList.add('visible');
    }

    addAiCharacterToGroup(mainChat) {
        const groupId = this.activeChatId;
        const chat = this.chats[groupId];
        if (!chat || !chat.isGroup) return;

        const characterId = `ai_${this.userId}_${mainChat.id}`;
        const charData = {
            characterId: characterId,
            originalName: mainChat.originalName || mainChat.name,
            avatar: (mainChat.settings && mainChat.settings.aiAvatar) || mainChat.avatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
            ownerUserId: this.userId,
            ownerNickname: this.nickname,
            mainChatId: mainChat.id
        };

        if (!this.aiCharactersInGroup[groupId]) this.aiCharactersInGroup[groupId] = [];
        this.aiCharactersInGroup[groupId].push(charData);
        this.saveAiCharacters();

        if (!chat.members.find(m => m.userId === characterId)) {
            chat.members.push({
                userId: characterId,
                nickname: charData.originalName,
                avatar: charData.avatar,
                isAiCharacter: true,
                ownerUserId: this.userId
            });
            this.saveChats();
        }

        this.send({
            type: 'ai_character_join',
            groupId: groupId,
            character: charData,
            members: chat.members.filter(m => !m.isAiCharacter).map(m => m.userId)
        });

        const sysMsg = { role: 'system', content: `${charData.originalName} (${this.nickname}的AI角色) 加入了群聊`, timestamp: Date.now() };
        this.addOnlineGroupMessage(groupId, sysMsg, { render: true, renderChatList: true });

        this.updateAiCallButton();
    }

    removeAiCharacterFromGroup(groupId) {
        const chars = this.aiCharactersInGroup[groupId] || [];
        const myChar = chars.find(c => c.ownerUserId === this.userId);
        if (!myChar) return;

        this.aiCharactersInGroup[groupId] = chars.filter(c => c.ownerUserId !== this.userId);
        this.saveAiCharacters();

        const chat = this.chats[groupId];
        if (chat) {
            chat.members = chat.members.filter(m => m.userId !== myChar.characterId);
            const sysMsg = { role: 'system', content: `${myChar.originalName} 离开了群聊`, timestamp: Date.now() };
            this.addOnlineGroupMessage(groupId, sysMsg, { render: true, renderChatList: false });
        }

        this.send({
            type: 'ai_character_leave',
            groupId: groupId,
            characterId: myChar.characterId,
            characterName: myChar.originalName,
            members: chat ? chat.members.map(m => m.userId) : []
        });

        this.renderChatList();
        this.updateAiCallButton();
    }

    onAiCharacterJoin(data) {
        const chat = this.chats[data.groupId];
        if (!chat) return;

        const charData = data.character;

        if (!this.aiCharactersInGroup[data.groupId]) this.aiCharactersInGroup[data.groupId] = [];
        if (!this.aiCharactersInGroup[data.groupId].find(c => c.characterId === charData.characterId)) {
            this.aiCharactersInGroup[data.groupId].push(charData);
            this.saveAiCharacters();
        }

        if (!chat.members.find(m => m.userId === charData.characterId)) {
            chat.members.push({
                userId: charData.characterId,
                nickname: charData.originalName,
                avatar: charData.avatar,
                isAiCharacter: true,
                ownerUserId: charData.ownerUserId
            });
        }

        const sysMsg = { role: 'system', content: `${charData.originalName} (${charData.ownerNickname}的AI角色) 加入了群聊`, timestamp: Date.now() };
        this.addOnlineGroupMessage(data.groupId, sysMsg, { render: true, renderChatList: true });
    }

    onAiCharacterLeave(data) {
        const chat = this.chats[data.groupId];
        if (!chat) return;

        if (this.aiCharactersInGroup[data.groupId]) {
            this.aiCharactersInGroup[data.groupId] = this.aiCharactersInGroup[data.groupId].filter(c => c.characterId !== data.characterId);
            this.saveAiCharacters();
        }

        chat.members = chat.members.filter(m => m.userId !== data.characterId);

        const sysMsg = { role: 'system', content: `${data.characterName} 离开了群聊`, timestamp: Date.now() };
        this.addOnlineGroupMessage(data.groupId, sysMsg, { render: true, renderChatList: true });
    }

    saveAiCharacters() {
        try {
            localStorage.setItem(this._getStorageKey('ai-characters'), JSON.stringify(this.aiCharactersInGroup));
        } catch (e) { console.error('保存AI角色数据失败:', e); }
    }

    loadAiCharacters() {
        try {
            const data = localStorage.getItem(this._getStorageKey('ai-characters'));
            if (data) this.aiCharactersInGroup = JSON.parse(data);
        } catch (e) { this.aiCharactersInGroup = {}; }
    }

    updateAiCallButton() {
        const btn = document.getElementById('online-app-ai-call-btn');
        if (!btn) return;

        const chat = this.chats[this.activeChatId];
        if (!chat || !chat.isGroup) {
            btn.style.display = 'none';
            return;
        }

        const chars = this.aiCharactersInGroup[this.activeChatId] || [];
        const myChar = chars.find(c => c.ownerUserId === this.userId);
        btn.style.display = myChar ? 'inline-flex' : 'none';
    }

    async triggerAiCharacterResponse() {
        if (this.isAiResponding) return;

        const groupId = this.activeChatId;
        const chat = this.chats[groupId];
        if (!chat || !chat.isGroup) return;

        const chars = this.aiCharactersInGroup[groupId] || [];
        const myChar = chars.find(c => c.ownerUserId === this.userId);
        if (!myChar) { alert('你还没有拉入AI角色'); return; }

        if (!window.state || !window.state.chats) {
            alert('主屏幕数据未加载');
            return;
        }
        const mainChat = window.state.chats[myChar.mainChatId];
        if (!mainChat) {
            alert('主屏幕中找不到该角色的聊天数据');
            return;
        }

        // 【对齐主屏 1-on-1】联机 AI 调用走 resolveApiSlotConfig('main')，
        // 与主屏聊天 (modules/ai-response.js:1833) 行为一致——能跟随主 API 预设切换。
        let resolvedConfig;
        try {
            resolvedConfig = typeof window.resolveApiSlotConfig === 'function'
                ? await window.resolveApiSlotConfig('main')
                : window.state.apiConfig;
        } catch (e) {
            console.error('[联机AI] 解析 API 配置失败:', e);
            alert('解析 API 配置失败：' + e.message);
            return;
        }
        if (!resolvedConfig || !resolvedConfig.proxyUrl || !resolvedConfig.apiKey || !resolvedConfig.model) {
            alert('请先在主屏幕的API设置中配置API');
            return;
        }

        this.isAiResponding = true;
        const btn = document.getElementById('online-app-ai-call-btn');
        if (btn) { btn.disabled = true; btn.textContent = '思考中...'; }

        try {
            const { proxyUrl, apiKey, model } = resolvedConfig;
            const systemPrompt = this.buildAiCharacterPrompt(mainChat, myChar, chat);
            const messagesPayload = this.buildAiCharacterMessages(chat, myChar);

            // 【对齐主屏 1-on-1】Gemini 严格匹配 (ai-response.js:4647)
            const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
            const isGemini = proxyUrl === GEMINI_API_URL;

            // 【对齐主屏 1-on-1】默认温度 0.8 (ai-response.js:4775)
            const apiTemperature = (window.state.globalSettings && window.state.globalSettings.apiTemperature) || 0.8;

            // 【对齐主屏 1-on-1】三段式：Gemini 直连 / 走代理（看 mainApiUseProxy 开关） / 直连兜底
            // 修 BUG：之前漏了直连兜底分支，导致非代理渠道在 file:// 部署下必报 Failed to fetch。
            let response;
            if (isGemini) {
                const geminiConfig = this.toGeminiRequest(model, apiKey, systemPrompt, messagesPayload);
                response = await fetch(geminiConfig.url, geminiConfig.data);
            } else {
                const useMainApiProxy = typeof window.fetchViaOpenAICompatibleProxy === 'function'
                    && typeof window.isMainApiProxyEnabled === 'function'
                    && window.isMainApiProxyEnabled();
                const payload = {
                    model: model,
                    messages: [{ role: 'system', content: systemPrompt }, ...messagesPayload],
                    temperature: apiTemperature,
                    stream: false
                };
                if (useMainApiProxy) {
                    // 与主屏一致 (ai-response.js:4782)：直接用 apiKey，不走 getRandomValue
                    response = await window.fetchViaOpenAICompatibleProxy({
                        baseUrl: proxyUrl,
                        targetPath: '/chat/completions',
                        apiKey: apiKey,
                        payload: payload,
                        method: 'POST'
                    });
                } else {
                    // 直连兜底（主屏同款，ai-response.js:4790）
                    const chatCompletionsUrl = `${proxyUrl.replace(/\/+$/, '')}/chat/completions`;
                    response = await fetch(chatCompletionsUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`
                        },
                        body: JSON.stringify(payload)
                    });
                }
            }

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error?.message || `API错误: ${response.status}`);
            }

            const data = await response.json();
            const rawContent = isGemini
                ? getGeminiResponseText(data)
                : (data?.choices?.[0]?.message?.content ?? getGeminiResponseText(data));

            if (!rawContent) throw new Error('AI返回了空内容');

            const replyTexts = this.parseAiCharacterResponse(rawContent);

            for (const text of replyTexts) {
                const timestamp = Date.now();
                const messageId = this.generateOnlineGroupMessageId(groupId, myChar.characterId, timestamp);

                this.send({
                    type: 'send_group_message',
                    groupId: groupId,
                    members: chat.members.filter(m => !m.isAiCharacter).map(m => m.userId),
                    fromUserId: myChar.characterId,
                    fromNickname: myChar.originalName,
                    fromAvatar: myChar.avatar,
                    message: text,
                    timestamp: timestamp,
                    isAiCharacter: true,
                    messageId: messageId,
                    clientMessageId: messageId
                });

                const msg = {
                    role: 'ai',
                    content: text,
                    timestamp: timestamp,
                    senderUserId: myChar.characterId,
                    senderNickname: myChar.originalName,
                    senderAvatar: myChar.avatar,
                    isAiCharacter: true,
                    messageId: messageId,
                    clientMessageId: messageId
                };
                this.addOnlineGroupMessage(groupId, msg, { render: true, renderChatList: false });

                if (replyTexts.indexOf(text) < replyTexts.length - 1) {
                    await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
                }
            }

            this.renderChatList();

            // 触发联机群聊自动记忆总结
            this.triggerOnlineGroupSummary(groupId);

        } catch (error) {
            console.error('AI角色回复失败:', error);
            alert('AI角色回复失败: ' + error.message);
        } finally {
            this.isAiResponding = false;
            if (btn) { btn.disabled = false; btn.textContent = '调用AI'; }
        }
    }

    /**
     * 【联机群聊自动记忆总结】
     * 照搬主屏 triggerAutoSummary (modules/memory-summary.js:3160) 的逻辑，
     * 但适配联机群聊：只为自己 AI 角色生成第一人称总结，
     * 写回 state.chats[mainChat.id].longTermMemory（主屏的长期记忆页面直接可见）。
     *
     * @param {string} groupId 联机群聊 ID
     * @param {object} [opts]  可选参数
     * @param {boolean} [opts.manual] 是否手动触发（跳过条数阈值检查 + 用 alert 反馈）
     * @param {boolean} [opts.force]  强制触发（忽略条数，但保留 5 条下限）
     * @returns {Promise<{triggered: boolean, reason?: string, summary?: string, error?: string}>}
     */
    async triggerOnlineGroupSummary(groupId, opts = {}) {
        if (this.isOnlineSummaryRunning) {
            console.log('[联机记忆] 已有总结任务在进行中，跳过:', groupId);
            return { triggered: false, reason: 'already_running' };
        }

        const chat = this.chats[groupId];
        if (!chat || !chat.isGroup) {
            return { triggered: false, reason: 'not_group' };
        }

        const chars = this.aiCharactersInGroup[groupId] || [];
        const myChar = chars.find(c => c.ownerUserId === this.userId);
        if (!myChar) {
            if (opts.manual) alert('该群还没有拉入你的 AI 角色，无法总结');
            return { triggered: false, reason: 'no_ai_character' };
        }

        if (!window.state || !window.state.chats) {
            return { triggered: false, reason: 'state_unavailable' };
        }
        const mainChat = window.state.chats[myChar.mainChatId];
        if (!mainChat) {
            if (opts.manual) alert('主屏幕中找不到该角色的聊天数据，无法总结');
            return { triggered: false, reason: 'main_chat_not_found' };
        }

        const interval = mainChat.settings?.autoMemoryInterval || 20;
        const lastTs = chat.lastMemorySummaryTimestamp || 0;

        // 照搬主屏 triggerAutoSummary 的过滤规则：非 system + 非 isHidden
        const messagesToSummarize = (chat.history || []).filter(m =>
            m && m.timestamp > lastTs && m.role !== 'system' && !m.isHidden
        );

        if (messagesToSummarize.length < 5) {
            if (opts.manual) {
                alert(`已总结过的消息之后只有 ${messagesToSummarize.length} 条新消息，至少需要 5 条才能进行有意义的总结。`);
            }
            return { triggered: false, reason: 'too_few_messages' };
        }

        if (!opts.manual && !opts.force && messagesToSummarize.length < interval) {
            return { triggered: false, reason: 'below_interval' };
        }

        this.isOnlineSummaryRunning = true;

        try {
            // === 格式化历史（照搬主屏 triggerAutoSummary 的格式化风格）===
            const formatDateTime = (ts) => new Date(ts).toLocaleString('zh-CN', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false
            });
            const startMsg = messagesToSummarize[0];
            const endMsg = messagesToSummarize[messagesToSummarize.length - 1];
            const timeRangeStr = `${formatDateTime(startMsg.timestamp)} 至 ${formatDateTime(endMsg.timestamp)}`;

            const userNickname = this.nickname || '我';
            const STICKER_RE = /(^https:\/\/i\.postimg\.cc\/.+|^https:\/\/files\.catbox\.moe\/.+|^https?:\/\/sharkpan\.xyz\/.+|^data:image|\.(png|jpg|jpeg|gif|webp)\?.*$|\.(png|jpg|jpeg|gif|webp)$)/i;

            const formattedHistory = messagesToSummarize.map(msg => {
                let sender;
                if (msg.role === 'user') {
                    sender = userNickname;
                } else if (msg.senderUserId === myChar.characterId) {
                    sender = myChar.originalName;
                } else {
                    sender = msg.senderNickname || '未知';
                }

                let content = msg.content || '';
                if (STICKER_RE.test(content)) {
                    const stickerLabel = msg.stickerName || msg.stickerMeaning;
                    content = stickerLabel ? `[表情: ${stickerLabel}]` : '[表情]';
                }
                if (typeof content !== 'string') {
                    if (msg.type === 'voice_message') content = `[语音: ${content}]`;
                    else if (msg.type === 'ai_image' || msg.type === 'user_photo') content = '[图片]';
                    else content = '[复杂消息]';
                }

                const msgTime = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
                return `[${msgTime}] ${sender}: ${content}`;
            }).filter(Boolean).join('\n');

            // 群成员列表（帮助 AI 理解场景）
            const membersList = (chat.members || []).map(m => {
                if (m.userId === myChar.ownerUserId) {
                    return `- **${m.nickname}**（你的主人/你认识的人）`;
                } else if (m.isAiCharacter) {
                    return `- **${m.nickname}**（另一个 AI 角色）`;
                }
                return `- **${m.nickname}**（联机群友）`;
            }).join('\n');

            // === System prompt ===
            // 照搬主屏 1-on-1 版本（memory-summary.js:3332）的第一人称模板，
            // 适配联机群聊场景，加入群成员上下文
            const systemPrompt = `
# 你的任务
你就是角色"${myChar.originalName}"。请你回顾一下刚才在联机群聊「${chat.name}」里和大家的对话，然后用【第一人称 ("我")】的口吻，总结出一段简短的、客观的、包含关键信息的记忆。请专注于重要的情绪、事件和细节。

# 对话时间范围
- **${timeRangeStr}**

# 核心规则
1.  **【视角铁律】**: 你的总结【必须】使用【主观的第一人称视角 ("我")】来写。
2.  **【内容核心 (最高优先级)】**: 你的总结【必须】专注于以下几点：
    *   **重要事件**: 刚才发生了什么具体的事情？特别是和谁一起聊了什么？
    *   **关键决定**: 我和大家达成了什么共识或做出了什么决定？
    *   **未来计划**: 我们约定了什么未来的计划或待办事项？
    *   **重要时间点**: 对话中提到了哪些具体的日期或时间？
3.  **【时间转换铁律 (必须遵守)】**: 如果对话中提到了相对时间（如"明天"、"后天"），你【必须】结合上面的【对话时间范围】信息，将其转换为【具体的公历日期】。
4.  **【风格要求】**: 你的总结应该像一份备忘录或要点记录，而不是一篇抒情散文。请尽量减少主观的心理感受描述，除非它直接导致了某个决定或计划。
5.  **【互动记录】**: 你的总结应该自然地记录"我和群里谁谁谁讨论了什么"，而不仅仅是你自己的独白。联机群聊里发生的事、对大家的了解都要记下来。

6.  **【输出格式】**: 你的回复【必须且只能】是一个JSON对象，格式如下：
    \`{"summary": "在这里写下你以第一人称视角，总结好的核心事实与计划。"}\`

# 你的角色设定
${mainChat.settings?.aiPersona || '（无）'}
# 你的聊天对象（用户）的人设
${mainChat.settings?.myPersona || '（无）'}

# 群成员
${membersList}

# 待总结的联机群聊对话
${formattedHistory}

现在，请以"${myChar.originalName}"的身份，开始你的客观总结。`;

            // === API 配置解析（优先副 API，没有副 API 用主 API）===
            let resolvedConfig;
            try {
                const secondaryConfig = typeof window.resolveApiSlotConfig === 'function'
                    ? await window.resolveApiSlotConfig('secondary')
                    : null;
                if (secondaryConfig && secondaryConfig.proxyUrl && secondaryConfig.apiKey && secondaryConfig.model) {
                    resolvedConfig = secondaryConfig;
                } else {
                    resolvedConfig = typeof window.resolveApiSlotConfig === 'function'
                        ? await window.resolveApiSlotConfig('main')
                        : window.state.apiConfig;
                }
            } catch (e) {
                console.error('[联机记忆] 解析 API 配置失败:', e);
                if (opts.manual) alert('解析 API 配置失败: ' + e.message);
                return { triggered: false, reason: 'api_config_error', error: e.message };
            }

            if (!resolvedConfig || !resolvedConfig.proxyUrl || !resolvedConfig.apiKey || !resolvedConfig.model) {
                const msg = '请先在主屏幕的 API 设置中配置主 API 或副 API';
                if (opts.manual) alert(msg);
                return { triggered: false, reason: 'api_not_configured' };
            }

            const { proxyUrl, apiKey, model } = resolvedConfig;
            const isGemini = proxyUrl.includes('generativelanguage');
            const apiTemperature = (window.state.globalSettings && window.state.globalSettings.apiTemperature) || 0.8;

            // === 三段式 fetch（复用刚改好的 AI 调用 pattern）===
            const useMainApiProxy = !isGemini
                && typeof window.fetchViaOpenAICompatibleProxy === 'function'
                && typeof window.isMainApiProxyEnabled === 'function'
                && window.isMainApiProxyEnabled();
            const payload = {
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: '请开始总结。' }
                ],
                temperature: apiTemperature,
                stream: false
            };

            let response;
            if (isGemini) {
                const geminiConfig = this.toGeminiRequest(model, apiKey, systemPrompt, [{ role: 'user', content: '请开始总结。' }]);
                response = await fetch(geminiConfig.url, geminiConfig.data);
            } else if (useMainApiProxy) {
                response = await window.fetchViaOpenAICompatibleProxy({
                    baseUrl: proxyUrl,
                    targetPath: '/chat/completions',
                    apiKey,
                    payload,
                    method: 'POST'
                });
            } else {
                const url = `${proxyUrl.replace(/\/+$/, '')}/chat/completions`;
                response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify(payload)
                });
            }

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                const errMsg = errData.error?.message || `API错误: ${response.status}`;
                if (opts.manual) alert('总结失败: ' + errMsg);
                throw new Error(errMsg);
            }

            const data = await response.json();
            const rawContent = isGemini
                ? getGeminiResponseText(data)
                : (data?.choices?.[0]?.message?.content ?? getGeminiResponseText(data));

            if (!rawContent) throw new Error('AI 返回了空内容');

            // 解析 JSON（容忍 markdown code fence）
            const cleaned = rawContent
                .replace(/^```json\s*/i, '')
                .replace(/^```\s*/i, '')
                .replace(/\s*```$/i, '')
                .trim();
            const result = JSON.parse(cleaned);

            if (!result.summary || !String(result.summary).trim()) {
                throw new Error('AI 返回的总结为空');
            }

            // === 写回主屏长期记忆（与主屏 triggerAutoSummary 同样的数据结构）===
            if (!Array.isArray(mainChat.longTermMemory)) mainChat.longTermMemory = [];
            mainChat.longTermMemory.push({
                content: String(result.summary).trim(),
                timestamp: Date.now(),
                source: opts.manual ? 'online_manual' : 'online_auto'
            });
            await db.chats.put(mainChat);

            // 标记联机群聊已总结到哪一条（用主屏同样的字段名）
            chat.lastMemorySummaryTimestamp = endMsg.timestamp;
            this.saveChats();

            const finalSummary = String(result.summary).trim();
            if (opts.manual) {
                alert(`总结完成！已添加 1 条新的长期记忆到「${mainChat.name}」的长期记忆页面。`);
            } else {
                console.log(`[联机记忆] 群「${chat.name}」自动总结完成（${messagesToSummarize.length} 条），写入 mainChat「${mainChat.name}」1 条记忆`);
            }

            return { triggered: true, summary: finalSummary };
        } catch (error) {
            console.error('[联机记忆] 总结失败:', error);
            if (opts.manual) alert('总结失败: ' + error.message);
            return { triggered: false, reason: 'error', error: error.message };
        } finally {
            this.isOnlineSummaryRunning = false;
        }
    }

    buildAiCharacterPrompt(mainChat, myChar, groupChat) {
        const ownerNickname = this.nickname;
        const charName = mainChat.originalName || mainChat.name;

        let longTermMemory = '- (暂无)';
        if (mainChat.longTermMemory && mainChat.longTermMemory.length > 0) {
            longTermMemory = mainChat.longTermMemory.map(mem => `- ${mem.content}`).join('\n');
        }

        let structuredMemoryText = '';
        if (window.structuredMemoryManager && mainChat.structuredMemory) {
            structuredMemoryText = window.structuredMemoryManager.serializeForPrompt(mainChat);
        }

        const membersList = (groupChat.members || []).map(m => {
            if (m.userId === myChar.ownerUserId) {
                return `- **${m.nickname}** (你的主人，你认识的人，你们有深厚的关系)`;
            } else if (m.isAiCharacter) {
                return `- **${m.nickname}** (另一个AI角色，你不认识)`;
            }
            return `- **${m.nickname}** (联机好友，你不认识这个人)`;
        }).join('\n');

        // 获取世界书内容
        let worldBookContent = '';
        if (window.state && window.state.worldBooks) {
            // 获取所有应该使用的世界书ID（包括手动选择的和全局的）
            let allWorldBookIds = [...(mainChat.settings.linkedWorldBookIds || [])];
            // 添加所有全局世界书
            window.state.worldBooks.forEach(wb => {
                if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) {
                    allWorldBookIds.push(wb.id);
                }
            });

            if (allWorldBookIds.length > 0) {
                const linkedContents = allWorldBookIds.map(bookId => {
                    const worldBook = window.state.worldBooks.find(wb => wb.id === bookId);
                    if (!worldBook || !Array.isArray(worldBook.content)) return '';
                    const formattedEntries = worldBook.content
                        .filter(entry => entry.enabled !== false)
                        .map(entry => {
                            let entryString = `\n### 条目: ${entry.comment || '无备注'}\n`;
                            entryString += `**内容:**\n${entry.content}`;
                            return entryString;
                        }).join('');
                    return formattedEntries ? `\n\n## 世界书: ${worldBook.name}\n${formattedEntries}` : '';
                }).filter(Boolean).join('');
                if (linkedContents) {
                    worldBookContent = `\n# --- 世界书 (World Book) ---
# 【最高优先级指令：绝对真理】
# 以下内容是你所在世界的"物理法则"和"基础常识"。
# 无论用户是否提及，你都【必须】时刻主动应用这些设定来指导你的思考和描写。
# 它们是无条件生效的，不需要触发词。
${linkedContents}
# --- 世界书设定结束 ---
`;
                }
            }
        }

        // 获取向量记忆内容
        let vectorMemoryContent = '';
        if (window.vectorMemoryManager) {
            const allFragments = window.vectorMemoryManager.getAllFragments(mainChat);
            if (allFragments && allFragments.length > 0) {
                // 按 importance 降序排序，取 top 10
                const topFragments = allFragments
                    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
                    .slice(0, 10);

                if (topFragments.length > 0) {
                    const fragmentLines = topFragments
                        .map(f => `- [importance=${f.importance || 0}] ${f.content}`)
                        .join('\n');
                    vectorMemoryContent = `\n## 重要记忆片段\n${fragmentLines}\n`;
                }
            }
        }

        return `# 【群聊AI角色模式】
你是 **${charName}**，你被你的主人 **${ownerNickname}** 拉入了一个联机群聊。

# 你的核心设定
${mainChat.settings.aiPersona || '(无人设)'}
${worldBookContent}
# 你与主人的关系
- **你的主人**: ${ownerNickname}
- **主人对你的备注**: ${mainChat.name}
- **主人的人设**: ${mainChat.settings.myPersona || '普通用户'}
你和${ownerNickname}之间有深厚的关系，你记得你们之间的一切。

# 你的长期记忆（与主人的）
${longTermMemory}
${structuredMemoryText}
${vectorMemoryContent}
# 当前群聊信息
- **群名**: ${groupChat.name}
- **群成员**:
${membersList}

# 重要规则
1. 你只认识 **${ownerNickname}**，其他群成员你都不认识。
2. 对不认识的人保持礼貌但有距离感，符合你的人设。
3. 对${ownerNickname}则像平时在主屏幕聊天一样自然亲密。
4. 你的回复必须是纯文本，可以拆分成多条短消息。
5. 像真人聊天一样回复，不要太正式。
6. 禁止透露你是AI。

# 输出格式
你的回复必须是一个JSON数组，每个元素是一条消息：
[{"type": "text", "content": "消息内容1"}, {"type": "text", "content": "消息内容2"}]
只输出JSON数组，不要输出其他内容。`;
    }

    buildAiCharacterMessages(groupChat, myChar) {
        const contextSize = groupChat.aiContextSize || 20;
        const history = (groupChat.history || []).slice(-contextSize);
        const STICKER_RE = /(^https:\/\/i\.postimg\.cc\/.+|^https:\/\/files\.catbox\.moe\/.+|^https?:\/\/sharkpan\.xyz\/.+|^data:image|\.(png|jpg|jpeg|gif|webp)\?.*$|\.(png|jpg|jpeg|gif|webp)$)/i;

        return history.filter(msg => msg.role !== 'system').map(msg => {
            const sender = msg.senderNickname || (msg.role === 'user' ? this.nickname : '未知');
            const isMyCharMsg = msg.senderUserId === myChar.characterId;

            let content = msg.content;

            // 检查是否是表情包消息
            if (STICKER_RE.test(msg.content)) {
                const stickerName = msg.stickerName || msg.stickerMeaning;
                if (stickerName) {
                    content = `用户发送了表情包 [${stickerName}]`;
                } else {
                    content = '[表情包]';
                }
            }

            return {
                role: isMyCharMsg ? 'assistant' : 'user',
                content: isMyCharMsg ? msg.content : `${sender}: ${content}`
            };
        });
    }

    parseAiCharacterResponse(content) {
        // 【照抄主屏幕 ai-response.js:1164 parseAiResponse 的 4 段解析策略 + video-voice-call.js:131 的 MinMax 清洗】
        // 联机群聊原本只有 1 段粗暴替换 ``` + JSON.parse，碰到 markdown code fence 包着的 JSON、
        // 带前缀文字的 [..}..] 格式、多个 {...} 散落在文本里都会漏——主屏幕这套 4 段策略
        // 在 Gemini 3.1 Pro / Minimax / 各种兼容 API 上验证过稳定。
        //
        // MinMax 漏思维链的修复：从 video-voice-call.js:131 学到，主屏对 MinMax 的清洗机制是
        // cleanMinimaxResponseText → stripMinimaxReasoningSections（剥 <think>>...</think>> 标签 + 思考/回复分割线）
        // 主屏 ai-response.js 主流程不调它（靠 prompt 不让模型输出 <think> 标签），
        // 但联机群聊的 prompt 跟主屏不一样，MinMax 真的会返回带 <think> 标签的回复——
        // 所以入口先调 cleanMinimaxResponseText 清洗，再走 4 段解析。
        //
        // 出口保持联机群聊的形态：filter(type==='text') → string[]
        if (!content) return [];

        // 0. 【照抄 video-voice-call.js:125-136】MinMax 思维链清洗
        //    只对 MinMax provider 跑，非 MinMax 跳过（与主屏/视频通话一致）
        let cleaned = content;
        try {
            const apiConfig = window.state && window.state.apiConfig;
            const provider = apiConfig ? (apiConfig.provider || apiConfig.proxyUrl || apiConfig.baseURL || apiConfig.baseUrl || '') : '';
            const isOfficialMinimax = String(provider || '').toLowerCase().includes('api.minimaxi.com');
            if (isOfficialMinimax && typeof window.cleanMinimaxResponseText === 'function') {
                cleaned = window.cleanMinimaxResponseText(content, {
                    provider,
                    model: apiConfig.model || ''
                }, {
                    fallbackText: ''
                });
            }
        } catch (e) {
            console.warn('联机AI MinMax清洗失败，继续原 content:', e);
        }

        let trimmedContent = cleaned.trim();

        // 1. 【照抄主屏 1173-1180】Markdown code fence 提取
        const markdownRegex = /```json\s*([\s\S]*?)\s*```/;
        const markdownMatch = trimmedContent.match(markdownRegex);
        if (markdownMatch && markdownMatch[1]) {
            trimmedContent = markdownMatch[1].trim();
        }

        // 2. 【照抄主屏 1183-1193】标准 JSON 数组解析
        if (trimmedContent.startsWith('[') && trimmedContent.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmedContent);
                if (Array.isArray(parsed)) {
                    return parsed
                        .filter(item => item.type === 'text' && item.content)
                        .map(item => String(item.content));
                }
            } catch (e) {
                console.warn('联机AI解析: 标准JSON数组解析失败，将尝试强力提取...');
            }
        }

        // 3. 【照抄主屏 1196-1218】强力提取 [ ... } ... ]（处理 AI 在 JSON 前后说废话）
        const startIndex = trimmedContent.indexOf('[');
        const lastBraceIndex = trimmedContent.lastIndexOf('}');
        if (startIndex !== -1 && lastBraceIndex !== -1 && lastBraceIndex > startIndex) {
            const endIndex = trimmedContent.indexOf(']', lastBraceIndex);
            if (endIndex !== -1) {
                const arrayString = trimmedContent.substring(startIndex, endIndex + 1);
                try {
                    const parsed = JSON.parse(arrayString);
                    if (Array.isArray(parsed)) {
                        return parsed
                            .filter(item => item.type === 'text' && item.content)
                            .map(item => String(item.content));
                    }
                } catch (e) {
                    console.warn('联机AI解析: 强力提取 [..}..] 失败，将尝试提取单个对象...');
                }
            }
        }

        // 4. 【照抄主屏 1221-1237】强力提取 {...}（处理单个 JSON 对象散落在文本里）
        const jsonMatches = trimmedContent.match(/{[^{}]*}/g);
        if (jsonMatches) {
            const results = [];
            for (const match of jsonMatches) {
                try {
                    const parsedObject = JSON.parse(match);
                    if (parsedObject && parsedObject.type === 'text' && parsedObject.content) {
                        results.push(String(parsedObject.content));
                    }
                } catch (e) {
                    // 跳过无效 JSON 片段
                }
            }
            if (results.length > 0) return results;
        }

        // 5. 【照抄主屏 1240-1244】所有解析方案均失败 fallback：返回原 cleaned content
        // 主屏 fallback 是 [{type:'text', content: originalContent}]；联机群聊要 string[] → [content]
        return [cleaned];
    }

    toGeminiRequest(model, apiKey, systemPrompt, messages) {
        const contents = [
            { role: 'user', parts: [{ text: systemPrompt }] },
            { role: 'model', parts: [{ text: '好的，我明白了。' }] },
            ...messages.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: String(m.content) }]
            }))
        ];
        return {
            url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${getRandomValue(apiKey)}`,
            data: {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: contents,
                    generationConfig: { temperature: (window.state && window.state.globalSettings && window.state.globalSettings.apiTemperature) || 0.8 }
                })
            }
        };
    }
}

const onlineChatManager = new OnlineChatManager();

function closeFriendRequestsModal() {
    const modal = document.getElementById('friend-requests-modal');
    if (modal) modal.classList.remove('visible');
}
function closeOnlineFriendsModal() {
    const modal = document.getElementById('online-friends-modal');
    if (modal) modal.classList.remove('visible');
}
function closeCreateGroupModal() {
    const modal = document.getElementById('create-group-modal');
    if (modal) modal.classList.remove('visible');
}
function closeGroupInfoModal() {
    const modal = document.getElementById('group-info-modal');
    if (modal) modal.classList.remove('visible');
}
function openOnlineHelpLink(type) {
    const urls = {
        explain: 'online-help-explain.html',
        guide: 'online-help-guide.html',
        deploy: 'online-help-deploy.html'
    };
    window.open(urls[type] || urls.explain, '_blank');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => onlineChatManager.initUI());
} else {
    onlineChatManager.initUI();
}
