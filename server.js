// ==================== EPhone 联机聊天服务器 ====================

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_USERS = 200;

// 在线用户 Map: userId -> { ws, nickname, avatar }
const onlineUsers = new Map();

// 真人联机群聊消息历史: groupId -> [message]
const groupMessageHistory = {};
const MAX_GROUP_HISTORY_MESSAGES = 300;

// ==================== HTTP 服务器 ====================

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('EPhone 联机服务器运行中');
});

// ==================== WebSocket 服务器 ====================

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    let currentUserId = null;

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
                    // 通知所有群成员（除了创建者）
                    const members = data.members || [];
                    console.log(`[群聊] 创建群聊请求: ${data.groupName}, 成员:`, members.map(m => m.userId));
                    members.forEach(member => {
                        if (member.userId !== data.creatorId) {
                            const memberUser = onlineUsers.get(member.userId);
                            console.log(`[群聊] 通知成员 ${member.userId}: ${memberUser ? '在线' : '不在线'}`);
                            if (memberUser) {
                                sendToClient(memberUser.ws, {
                                    type: 'receive_group_created',
                                    groupId: data.groupId,
                                    groupName: data.groupName,
                                    members: data.members,
                                    creatorId: data.creatorId,
                                    timestamp: Date.now()
                                });
                            }
                        }
                    });
                    console.log(`[群聊] ${data.creatorId} 创建了群聊 ${data.groupName} (${members.length}人)`);
                    break;
                }

                case 'get_group_history': {
                    const groupId = data.groupId;
                    sendToClient(ws, {
                        type: 'group_history',
                        groupId: groupId,
                        messages: groupId && groupMessageHistory[groupId] ? groupMessageHistory[groupId] : []
                    });
                    break;
                }

                case 'send_group_message': {
                    // 转发群消息给所有群成员（除了发送者），并保存真人联机群聊内存历史
                    const groupMembers = data.members || [];
                    const groupMessage = {
                        type: 'receive_group_message',
                        groupId: data.groupId,
                        fromUserId: data.fromUserId,
                        fromNickname: data.fromNickname,
                        fromAvatar: data.fromAvatar,
                        message: data.message,
                        timestamp: data.timestamp,
                        isAiCharacter: data.isAiCharacter || false,
                        messageId: data.messageId || data.clientMessageId,
                        clientMessageId: data.clientMessageId || data.messageId
                    };

                    if (data.groupId) {
                        if (!groupMessageHistory[data.groupId]) groupMessageHistory[data.groupId] = [];
                        groupMessageHistory[data.groupId].push(groupMessage);
                        if (groupMessageHistory[data.groupId].length > MAX_GROUP_HISTORY_MESSAGES) {
                            groupMessageHistory[data.groupId].splice(0, groupMessageHistory[data.groupId].length - MAX_GROUP_HISTORY_MESSAGES);
                        }
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

                case 'ai_character_join': {
                    // 通知群成员有AI角色加入
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
                    // 通知群成员AI角色离开
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
