// ==================== EPhone 联机聊天服务器 ====================

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_USERS = 200;

// 在线用户 Map: userId -> { ws, nickname, avatar }
const onlineUsers = new Map();

const fs = require('fs');
const path = require('path');

// 真人联机群聊状态: groupId -> { id, name, members, owner, timestamp }
const onlineGroups = new Map();

// 真人联机群聊持久化存储
const GROUP_STORAGE_FILE = path.join(__dirname, 'online-groups.json');
const GROUP_MESSAGE_STORAGE_FILE = path.join(__dirname, 'online-group-messages.json');

// 真人联机群聊消息历史: groupId -> [message]
let groupMessageHistory = {};
const MAX_GROUP_HISTORY_MESSAGES = 300;

// ========== 持久化参数 ==========
const PERSIST_DEBOUNCE_MS = 500;                  // 防抖：500ms 内多次 persist 合并成一次实际写入
const PERSIST_MAX_FILE_BYTES = 5 * 1024 * 1024;   // 消息历史文件超过 5MB 触发自动裁剪
const PERSIST_TRIM_TO_PER_GROUP = 200;            // 裁剪后每个群保留的最近消息数（比 MAX_GROUP_HISTORY_MESSAGES 更紧，避免再次爆文件）
const PERSIST_RETRY_DELAY_MS = 2000;              // 写入失败后重试间隔
// ================================

// 持久化调度状态（按文件路径）
const _pendingWrites = Object.create(null);   // filePath -> true 表示有未写入的修改
const _writeTimers = Object.create(null);     // filePath -> setTimeout handle

function loadJsonFile(filePath, fallback) {
    // 主文件读失败时尝试 .bak
    const tryRead = (p) => {
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, 'utf8');
        return raw ? JSON.parse(raw) : null;
    };

    try {
        const data = tryRead(filePath);
        if (data !== null) return data;
    } catch (error) {
        console.error('[群聊] 读取主持久化文件失败，尝试 .bak 备份:', filePath, error.message);
        try {
            const data = tryRead(filePath + '.bak');
            if (data !== null) {
                console.warn('[群聊] 已从 .bak 备份恢复:', filePath);
                return data;
            }
        } catch (bakErr) {
            console.error('[群聊] 读取 .bak 备份也失败:', filePath + '.bak', bakErr.message);
        }
    }
    return fallback;
}

function backupFileSync(filePath) {
    if (!fs.existsSync(filePath)) return;
    try {
        fs.copyFileSync(filePath, filePath + '.bak');
    } catch (error) {
        console.warn('[群聊] 备份文件失败（继续写入）:', filePath, error.message);
    }
}

function maybeTrimGroupMessages() {
    // 检查上次持久化的文件大小，超阈值就裁剪每个群到 PERSIST_TRIM_TO_PER_GROUP 条
    let totalSize = 0;
    try {
        if (fs.existsSync(GROUP_MESSAGE_STORAGE_FILE)) {
            totalSize = fs.statSync(GROUP_MESSAGE_STORAGE_FILE).size;
        }
    } catch (_) {}

    if (totalSize <= PERSIST_MAX_FILE_BYTES) return;

    let trimmedAny = false;
    for (const groupId of Object.keys(groupMessageHistory)) {
        const arr = groupMessageHistory[groupId];
        if (Array.isArray(arr) && arr.length > PERSIST_TRIM_TO_PER_GROUP) {
            groupMessageHistory[groupId] = arr.slice(-PERSIST_TRIM_TO_PER_GROUP);
            trimmedAny = true;
        }
    }
    if (trimmedAny) {
        console.warn(`[群聊] 文件 ${(totalSize / 1024 / 1024).toFixed(2)}MB 超阈值，已裁剪每群到 ${PERSIST_TRIM_TO_PER_GROUP} 条`);
    }
}

function collectPersistData(filePath) {
    if (filePath === GROUP_MESSAGE_STORAGE_FILE) {
        maybeTrimGroupMessages();
        return groupMessageHistory;
    }
    if (filePath === GROUP_STORAGE_FILE) {
        return Array.from(onlineGroups.values());
    }
    return null;
}

function doWriteFileAsync(filePath) {
    const data = collectPersistData(filePath);
    if (data === null) {
        _pendingWrites[filePath] = false;
        return;
    }

    let json;
    try {
        json = JSON.stringify(data, null, 2);
    } catch (err) {
        console.error('[群聊] 序列化失败:', filePath, err.message);
        _pendingWrites[filePath] = false;
        return;
    }

    const tmpPath = filePath + '.tmp';
    fs.writeFile(tmpPath, json, 'utf8', (err) => {
        if (err) {
            console.error('[群聊] 写入临时文件失败:', filePath, err.message);
            schedulePersistRetry(filePath);
            return;
        }
        // 写入成功 → 备份当前文件 → 原子重命名
        backupFileSync(filePath);
        fs.rename(tmpPath, filePath, (err2) => {
            if (err2) {
                console.error('[群聊] 原子重命名失败:', filePath, err2.message);
                // 重命名失败通常意味着目标文件被占用或权限问题，安排重试
                try { fs.unlinkSync(tmpPath); } catch (_) {}
                schedulePersistRetry(filePath);
                return;
            }
            _pendingWrites[filePath] = false;
        });
    });
}

function schedulePersistRetry(filePath) {
    if (_writeTimers[filePath]) return;
    _writeTimers[filePath] = setTimeout(() => {
        _writeTimers[filePath] = null;
        if (_pendingWrites[filePath]) {
            doWriteFileAsync(filePath);
        }
    }, PERSIST_RETRY_DELAY_MS);
}

function schedulePersist(filePath) {
    _pendingWrites[filePath] = true;
    if (_writeTimers[filePath]) return;  // 已经有定时器在排队
    _writeTimers[filePath] = setTimeout(() => {
        _writeTimers[filePath] = null;
        if (_pendingWrites[filePath]) {
            doWriteFileAsync(filePath);
        }
    }, PERSIST_DEBOUNCE_MS);
}

function persistOnlineGroups() {
    schedulePersist(GROUP_STORAGE_FILE);
}

function persistGroupMessages() {
    schedulePersist(GROUP_MESSAGE_STORAGE_FILE);
}

function flushPendingWritesSync() {
    // 进程退出前同步 flush 所有待写入数据，避免丢消息
    const paths = Object.keys(_writeTimers);
    for (const filePath of paths) {
        if (_writeTimers[filePath]) {
            clearTimeout(_writeTimers[filePath]);
            _writeTimers[filePath] = null;
        }
        if (!_pendingWrites[filePath]) continue;
        try {
            const data = collectPersistData(filePath);
            if (data === null) {
                _pendingWrites[filePath] = false;
                continue;
            }
            const json = JSON.stringify(data, null, 2);
            const tmpPath = filePath + '.tmp';
            fs.writeFileSync(tmpPath, json, 'utf8');
            if (fs.existsSync(filePath)) {
                backupFileSync(filePath);
            }
            fs.renameSync(tmpPath, filePath);
            _pendingWrites[filePath] = false;
            console.log('[群聊] flush 完成:', filePath);
        } catch (e) {
            console.error('[群聊] flush 失败:', filePath, e.message);
        }
    }
}

// 进程退出钩子：保证数据不丢
process.on('SIGTERM', () => {
    console.log('[群聊] 收到 SIGTERM，flush 持久化...');
    flushPendingWritesSync();
    process.exit(0);
});
process.on('SIGINT', () => {
    console.log('[群聊] 收到 SIGINT，flush 持久化...');
    flushPendingWritesSync();
    process.exit(0);
});
process.on('beforeExit', () => {
    flushPendingWritesSync();
});

function loadPersistedGroups() {
    const groups = loadJsonFile(GROUP_STORAGE_FILE, []);
    if (Array.isArray(groups)) {
        groups.forEach(group => {
            if (group && group.id) {
                onlineGroups.set(group.id, group);
            }
        });
    }
    groupMessageHistory = loadJsonFile(GROUP_MESSAGE_STORAGE_FILE, {});
}
loadPersistedGroups();

// ==================== HTTP 服务器 ====================

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('EPhone 联机服务器运行中');
});

// ==================== WebSocket 服务器 ====================

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    let currentUserId = null;

    // ============ 【P0 主动探活】服务端 ping/pong ============
    // 手机切后台时浏览器主线程被冻结，client → server 方向的数据（包括心跳）
    // 全部暂停，服务端被动等待就会被反向代理 60s 超时踢掉——客户端 onclose 触发
    // 后才"突然"感知到掉线。
    //
    // 现在服务端每 30s 主动 ws.ping()，浏览器自动响应 pong frame（WebSocket 协议层，
    // 不需要前端 JS 处理）。如果 60s 内没收到 pong 就 ws.terminate() 主动断开，
    // 让客户端立刻走重连流程，而不是傻等到反向代理超时。
    //
    // 关键收益：
    // 1. 切后台短时间（< 30s）：客户端解冻后浏览器自动回 pong → 服务端视为活的，不踢
    // 2. 切后台长时间（> 60s）：服务端主动 terminate → 客户端解冻后立刻感知重连
    // 3. 真断网：服务端 60s 探测无响应 → 主动踢掉 → 客户端重连（用户感知一致）
    let lastPongTime = Date.now();
    const pingInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            try { ws.ping(); } catch (_) {}
        } else {
            clearInterval(pingInterval);
        }
    }, 30000);

    const pongCheckInterval = setInterval(() => {
        const sinceLastPong = Date.now() - lastPongTime;
        if (sinceLastPong > 60000) {
            console.log(`[连接] ${currentUserId || '未注册'} pong 超时 ${Math.round(sinceLastPong / 1000)}s，主动断开`);
            try { ws.terminate(); } catch (_) {}
            clearInterval(pingInterval);
            clearInterval(pongCheckInterval);
        }
    }, 10000);

    ws.on('pong', () => {
        lastPongTime = Date.now();
    });
    // ============================================================

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);

            switch (data.type) {
                case 'register': {
                    const { userId, nickname, avatar } = data;
                    if (!userId || !nickname) {
                        sendToClient(ws, { type: 'register_error', error: '缺少必要参数' });
                        return;
                    }
                    if (onlineUsers.size >= MAX_USERS && !onlineUsers.has(userId)) {
                        sendToClient(ws, { type: 'register_error', error: '服务器已满' });
                        return;
                    }
                    currentUserId = userId;
                    onlineUsers.set(userId, { ws, nickname, avatar });
                    sendToClient(ws, { type: 'register_success' });
                    console.log(`[注册] ${nickname} (${userId}) 已上线，当前在线: ${onlineUsers.size}`);
                    break;
                }

                case 'heartbeat': {
                    sendToClient(ws, { type: 'heartbeat_ack' });
                    break;
                }

                case 'search_user': {
                    const target = onlineUsers.get(data.searchId);
                    if (target) {
                        sendToClient(ws, {
                            type: 'search_result',
                            found: true,
                            user: { userId: data.searchId, nickname: target.nickname, avatar: target.avatar }
                        });
                    } else {
                        sendToClient(ws, { type: 'search_result', found: false });
                    }
                    break;
                }

                case 'friend_request': {
                    const targetUser = onlineUsers.get(data.toUserId);
                    if (targetUser) {
                        sendToClient(targetUser.ws, {
                            type: 'friend_request',
                            fromUserId: data.fromUserId,
                            fromNickname: data.fromNickname,
                            fromAvatar: data.fromAvatar
                        });
                    }
                    break;
                }

                case 'accept_friend_request': {
                    const requester = onlineUsers.get(data.fromUserId);
                    if (requester) {
                        sendToClient(requester.ws, {
                            type: 'friend_request_accepted',
                            fromUserId: data.toUserId,
                            fromNickname: data.toNickname,
                            fromAvatar: data.toAvatar
                        });
                    }
                    break;
                }

                case 'reject_friend_request': {
                    const requester = onlineUsers.get(data.fromUserId);
                    if (requester) {
                        sendToClient(requester.ws, { type: 'friend_request_rejected' });
                    }
                    break;
                }

                case 'send_message': {
                    const recipient = onlineUsers.get(data.toUserId);
                    if (recipient) {
                        sendToClient(recipient.ws, {
                            type: 'receive_message',
                            fromUserId: data.fromUserId,
                            message: data.message,
                            timestamp: data.timestamp
                        });
                    }
                    break;
                }

                case 'create_group': {
                    const members = Array.isArray(data.members) ? data.members : [];
                    const owner = data.creatorId || data.owner || currentUserId;

                    onlineGroups.set(data.groupId, {
                        id: data.groupId,
                        name: data.groupName,
                        members: members,
                        owner: owner,
                        timestamp: Date.now()
                    });
                    persistOnlineGroups();

                    console.log(`[群聊] 创建群聊请求: ${data.groupName}, 成员:`, members.map(m => m.userId));
                    members.forEach(member => {
                        if (member.userId !== owner) {
                            const memberUser = onlineUsers.get(member.userId);
                            console.log(`[群聊] 通知成员 ${member.userId}: ${memberUser ? '在线' : '不在线'}`);
                            if (memberUser) {
                                sendToClient(memberUser.ws, {
                                    type: 'receive_group_created',
                                    groupId: data.groupId,
                                    groupName: data.groupName,
                                    members: members,
                                    creatorId: owner,
                                    owner: owner,
                                    timestamp: Date.now()
                                });
                            }
                        }
                    });
                    console.log(`[群聊] ${owner} 创建了群聊 ${data.groupName} (${members.length}人)`);
                    break;
                }

                case 'add_group_members': {
                    const group = onlineGroups.get(data.groupId);
                    if (!group) {
                        sendToClient(ws, { type: 'group_error', action: 'add_group_members', error: '群聊不存在', groupId: data.groupId });
                        break;
                    }

                    if (group.owner !== currentUserId) {
                        sendToClient(ws, { type: 'group_error', action: 'add_group_members', error: '只有群主可以拉人入群', groupId: data.groupId });
                        break;
                    }

                    const newMembers = Array.isArray(data.newMembers) ? data.newMembers : [];
                    const existingIds = new Set((group.members || []).map(member => member.userId));
                    const uniqueNewMembers = newMembers.filter(member => member && member.userId && !existingIds.has(member.userId));

                    if (uniqueNewMembers.length === 0) {
                        sendToClient(ws, {
                            type: 'group_members_added',
                            groupId: data.groupId,
                            addedMembers: [],
                            members: group.members || [],
                            owner: group.owner
                        });
                        break;
                    }

                    group.members = [...(group.members || []), ...uniqueNewMembers];
                    group.timestamp = Date.now();
                    onlineGroups.set(data.groupId, group);
                    persistOnlineGroups();

                    const operator = onlineUsers.get(currentUserId);
                    const operatorNickname = data.operatorNickname || operator?.nickname || currentUserId;
                    const addedAt = Date.now();

                    uniqueNewMembers.forEach(member => {
                        const memberUser = onlineUsers.get(member.userId);
                        if (memberUser) {
                            sendToClient(memberUser.ws, {
                                type: 'receive_group_created',
                                groupId: group.id,
                                groupName: group.name,
                                members: group.members,
                                creatorId: group.owner,
                                owner: group.owner,
                                timestamp: addedAt
                            });
                            sendToClient(memberUser.ws, {
                                type: 'group_members_added',
                                groupId: group.id,
                                groupName: group.name,
                                addedMembers: uniqueNewMembers,
                                members: group.members,
                                owner: group.owner,
                                operatorUserId: currentUserId,
                                operatorNickname: operatorNickname,
                                timestamp: addedAt
                            });
                        }
                    });

                    (group.members || []).forEach(member => {
                        if (member.userId === currentUserId) return;
                        if (uniqueNewMembers.some(newMember => newMember.userId === member.userId)) return;
                        const memberUser = onlineUsers.get(member.userId);
                        if (memberUser) {
                            sendToClient(memberUser.ws, {
                                type: 'group_members_added',
                                groupId: group.id,
                                groupName: group.name,
                                addedMembers: uniqueNewMembers,
                                members: group.members,
                                owner: group.owner,
                                operatorUserId: currentUserId,
                                operatorNickname: operatorNickname,
                                timestamp: addedAt
                            });
                        }
                    });

                    sendToClient(ws, {
                        type: 'group_members_added',
                        groupId: group.id,
                        groupName: group.name,
                        addedMembers: uniqueNewMembers,
                        members: group.members,
                        owner: group.owner,
                        operatorUserId: currentUserId,
                        operatorNickname: operatorNickname,
                        timestamp: addedAt
                    });

                    console.log(`[群聊] ${currentUserId} 向群 ${group.name} 新增成员:`, uniqueNewMembers.map(member => member.userId));
                    break;
                }

                case 'get_my_groups': {
                    if (!currentUserId) {
                        sendToClient(ws, { type: 'my_groups', groups: [] });
                        break;
                    }

                    const groups = [];
                    onlineGroups.forEach(group => {
                        const isMember = Array.isArray(group.members) && group.members.some(member => member.userId === currentUserId);
                        if (isMember) {
                            groups.push({
                                id: group.id,
                                name: group.name,
                                members: group.members || [],
                                owner: group.owner || '',
                                timestamp: group.timestamp || Date.now(),
                                history: group.id && groupMessageHistory[group.id] ? groupMessageHistory[group.id] : []
                            });
                        }
                    });

                    sendToClient(ws, { type: 'my_groups', groups });
                    break;
                }

                case 'get_group_history': {
                    const groupId = data.groupId;
                    const sinceMessageId = data.sinceMessageId || null;
                    let history = groupId && groupMessageHistory[groupId] ? groupMessageHistory[groupId] : [];

                    // 增量返回：客户端带上 sinceMessageId，服务端只返回比它新的消息。
                    // 这样客户端切回前台时只补差，不用每次重传整段历史。
                    if (sinceMessageId && Array.isArray(history) && history.length > 0) {
                        const idx = history.findIndex(m => m && (m.messageId === sinceMessageId || m.clientMessageId === sinceMessageId));
                        if (idx >= 0) {
                            history = history.slice(idx + 1);
                        }
                        // 如果服务端历史里没找到 sinceMessageId（说明客户端本地有而服务端没的，
                        // 或者服务端早就裁掉了），就返回整个服务端历史让客户端按 messageId 去重合并。
                    }

                    sendToClient(ws, {
                        type: 'group_history',
                        groupId: groupId,
                        messages: history,
                        sinceMessageId: sinceMessageId || null,
                        serverTotal: (groupId && groupMessageHistory[groupId]) ? groupMessageHistory[groupId].length : 0
                    });
                    break;
                }

                case 'send_group_message': {
                    const groupMembers = data.members || [];
                    const messageId = data.messageId || data.clientMessageId || null;

                    // 【去重】客户端可能在网络不稳时重发同一条消息，按 messageId 兜底去重
                    // （虽然在线 send 已经本地 dedup，但离线发送重连后重传的场景需要服务端也去重）
                    if (messageId && data.groupId && Array.isArray(groupMessageHistory[data.groupId])) {
                        const dup = groupMessageHistory[data.groupId].some(m =>
                            m && (m.messageId === messageId || m.clientMessageId === messageId)
                        );
                        if (dup) {
                            console.log(`[群聊] 忽略重复消息: ${messageId} (group=${data.groupId})`);
                            break;
                        }
                    }

                    const groupMessage = {
                        type: 'receive_group_message',
                        groupId: data.groupId,
                        fromUserId: data.fromUserId,
                        fromNickname: data.fromNickname,
                        fromAvatar: data.fromAvatar,
                        message: data.message,
                        timestamp: data.timestamp,
                        isAiCharacter: data.isAiCharacter || false,
                        messageId: messageId,
                        clientMessageId: data.clientMessageId || messageId
                    };

                    if (data.groupId) {
                        if (!groupMessageHistory[data.groupId]) groupMessageHistory[data.groupId] = [];
                        groupMessageHistory[data.groupId].push(groupMessage);
                        if (groupMessageHistory[data.groupId].length > MAX_GROUP_HISTORY_MESSAGES) {
                            groupMessageHistory[data.groupId].splice(0, groupMessageHistory[data.groupId].length - MAX_GROUP_HISTORY_MESSAGES);
                        }
                        persistGroupMessages();
                    }

                    groupMembers.forEach(memberId => {
                        if (memberId !== data.fromUserId) {
                            const memberUser = onlineUsers.get(memberId);
                            if (memberUser) {
                                sendToClient(memberUser.ws, groupMessage);
                            }
                        }
                    });
                    break;
                }

                case 'remove_group_member': {
                    const group = onlineGroups.get(data.groupId);
                    if (!group) {
                        sendToClient(ws, { type: 'group_error', action: 'remove_group_member', error: '群聊不存在', groupId: data.groupId });
                        break;
                    }

                    if (group.owner !== currentUserId) {
                        sendToClient(ws, { type: 'group_error', action: 'remove_group_member', error: '只有群主可以移除成员', groupId: data.groupId });
                        break;
                    }

                    const targetMember = (group.members || []).find(member => member.userId === data.memberUserId);
                    if (!targetMember) {
                        sendToClient(ws, { type: 'group_error', action: 'remove_group_member', error: '成员不存在', groupId: data.groupId });
                        break;
                    }

                    group.members = (group.members || []).filter(member => member.userId !== data.memberUserId);
                    group.timestamp = Date.now();
                    onlineGroups.set(data.groupId, group);
                    persistOnlineGroups();

                    const payload = {
                        type: 'member_removed',
                        groupId: data.groupId,
                        memberUserId: data.memberUserId,
                        members: group.members,
                        owner: group.owner,
                        timestamp: group.timestamp
                    };

                    const targetUser = onlineUsers.get(data.memberUserId);
                    if (targetUser) {
                        sendToClient(targetUser.ws, payload);
                    }

                    (group.members || []).forEach(member => {
                        if (member.userId === data.memberUserId) return;
                        const memberUser = onlineUsers.get(member.userId);
                        if (memberUser) {
                            sendToClient(memberUser.ws, payload);
                        }
                    });

                    sendToClient(ws, payload);
                    console.log(`[群聊] ${currentUserId} 从群 ${group.name} 移除了成员 ${data.memberUserId}`);
                    break;
                }

                case 'ai_character_join': {
                    const joinMembers = data.members || [];
                    joinMembers.forEach(memberId => {
                        if (memberId !== currentUserId) {
                            const memberUser = onlineUsers.get(memberId);
                            if (memberUser) {
                                sendToClient(memberUser.ws, {
                                    type: 'ai_character_join',
                                    groupId: data.groupId,
                                    character: data.character
                                });
                            }
                        }
                    });
                    console.log(`[AI角色] ${data.character.originalName} 加入群聊 ${data.groupId}`);
                    break;
                }

                case 'ai_character_leave': {
                    const leaveMembers = data.members || [];
                    leaveMembers.forEach(memberId => {
                        if (memberId !== currentUserId) {
                            const memberUser = onlineUsers.get(memberId);
                            if (memberUser) {
                                sendToClient(memberUser.ws, {
                                    type: 'ai_character_leave',
                                    groupId: data.groupId,
                                    characterId: data.characterId,
                                    characterName: data.characterName
                                });
                            }
                        }
                    });
                    console.log(`[AI角色] ${data.characterName} 离开群聊 ${data.groupId}`);
                    break;
                }

                default:
                    console.warn('[警告] 未知消息类型:', data.type);
            }
        } catch (error) {
            console.error('[错误] 处理消息失败:', error);
        }
    });

    ws.on('close', () => {
        clearInterval(pingInterval);
        clearInterval(pongCheckInterval);
        if (currentUserId) {
            const user = onlineUsers.get(currentUserId);
            if (user) {
                console.log(`[离线] ${user.nickname} (${currentUserId}) 已下线`);
            }
            onlineUsers.delete(currentUserId);
        }
    });

    ws.on('error', (error) => {
        console.error('[WebSocket错误]', error.message);
    });
});

// ==================== 工具函数 ====================

/**
 * 安全地发送消息给客户端
 */
function sendToClient(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(data));
        } catch (error) {
            console.error('[错误] 发送消息失败:', error);
        }
    }
}

/**
 * 广播消息给所有在线用户（保留接口，暂未使用）
 */
function broadcast(data, excludeUserId = null) {
    const message = JSON.stringify(data);
    onlineUsers.forEach((user, userId) => {
        if (userId !== excludeUserId && user.ws.readyState === WebSocket.OPEN) {
            user.ws.send(message);
        }
    });
}

// ==================== 服务器启动 ====================

server.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(60));
    console.log('                  ✅ 服务器启动成功！                   ');
    console.log('='.repeat(60));
    console.log(`📡 WebSocket端口: ${PORT}`);
    console.log(`🌐 HTTP访问: http://localhost:${PORT}`);
    console.log(`⏰ 启动时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    console.log(`👥 最大用户数: ${MAX_USERS}`);
    console.log('='.repeat(60));
    console.log('');
    console.log('💡 提示:');
    console.log('  - 使用 Ctrl+C 停止服务器');
    console.log('  - 使用 PM2 可以让服务器持续运行');
    console.log('  - 确保防火墙已开放端口 ' + PORT);
    console.log('');
});

// ==================== 定时任务 ====================

// 每30秒显示一次在线用户数
setInterval(() => {
    const timestamp = new Date().toLocaleTimeString('zh-CN');
    console.log(`[${timestamp}] 当前在线用户: ${onlineUsers.size}`);
}, 30000);

// 每5分钟清理断开的连接
setInterval(() => {
    let cleaned = 0;
    onlineUsers.forEach((user, userId) => {
        if (user.ws.readyState !== WebSocket.OPEN) {
            onlineUsers.delete(userId);
            cleaned++;
        }
    });
    if (cleaned > 0) {
        console.log(`[清理] 清理了 ${cleaned} 个断开的连接`);
    }
}, 5 * 60 * 1000);

// ==================== 优雅关闭 ====================

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
    console.log('\n');
    console.log('='.repeat(60));
    console.log('正在关闭服务器...');

    // 通知所有客户端
    onlineUsers.forEach((user) => {
        sendToClient(user.ws, {
            type: 'server_shutdown',
            message: '服务器正在维护，请稍后重新连接'
        });
        user.ws.close();
    });

    // 关闭WebSocket服务器
    wss.close(() => {
        console.log('WebSocket服务器已关闭');

        // 关闭HTTP服务器
        server.close(() => {
            console.log('HTTP服务器已关闭');
            console.log('服务器已安全关闭');
            console.log('='.repeat(60));
            process.exit(0);
        });
    });

    // 强制关闭超时
    setTimeout(() => {
        console.error('强制关闭服务器');
        process.exit(1);
    }, 10000);
}

// ==================== 错误处理 ====================

process.on('uncaughtException', (error) => {
    console.error('[严重错误] 未捕获的异常:', error);
});

process.on('unhandledRejection', (reason) => {
    console.error('[警告] 未处理的Promise拒绝:', reason);
});

// ==================== 服务器信息 ====================

console.log('服务器配置:');
console.log(`  Node.js版本: ${process.version}`);
console.log(`  操作系统: ${process.platform}`);
console.log(`  进程ID: ${process.pid}`);
console.log('');
