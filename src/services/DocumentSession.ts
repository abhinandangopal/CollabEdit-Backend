import { WebSocket } from 'ws';
import Redis from 'ioredis';
import { Kafka } from 'kafkajs';

interface UserState {
    socket: WebSocket;
    userId: string;
    color: string;
    role: string;
}

interface EditOperation {
    type: 'update' | 'cursor' | 'sync' | 'fetch_history' | 'history_list' | 'restore' | 'chat' | 'chat_history' | 'delete_chat' | 'system' | 'user_list' | 'access_info' | 'typing'; 
    content?: string; 
    userId?: string;
    range?: any;
    color?: string;
    list?: any[]; 
    timestamp?: number;
    message?: string; 
    quote?: string; 
    chatId?: number;
    role?: string;
    isTyping?: boolean;
}

export class DocumentSession {
    private documentId: string;
    private connections: Map<string, UserState>; 
    private redisClient: Redis;
    private kafkaProducer: any;

    constructor(docId: string, kafkaProducer: any) {
        this.documentId = docId;
        this.connections = new Map();
        this.kafkaProducer = kafkaProducer;
        const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
        this.redisClient = new Redis({ host: REDIS_HOST, port: 6379 }); 
    }

    public async addUser(socket: WebSocket, userId: string, role: string) {
        const connectionId = Math.random().toString(36).substring(7);
        const color = '#' + userId.substring(0, 6).padEnd(6, '0').replace(/[^0-9a-f]/gi, '0');
        
        this.connections.set(connectionId, { socket, userId, color, role });
        
        socket.send(JSON.stringify({ type: 'access_info', role: role, message: `Joined as ${role}` }));
        this.broadcast(connectionId, JSON.stringify({ type: 'system', message: `User ${userId} joined`, color: 'green' }));
        this.broadcastUserList();
        
        const savedContent = await this.redisClient.get(`doc:${this.documentId}`);
        if (savedContent) {
            socket.send(JSON.stringify({ type: 'sync', content: savedContent }));
        }

        this.sendChatHistory(socket);
        return connectionId;
    }

    public removeUser(connectionId: string) {
        const user = this.connections.get(connectionId);
        if (user) {
            this.connections.delete(connectionId);
            this.broadcast(connectionId, JSON.stringify({ type: 'system', message: `User ${user.userId} left`, color: 'red' }));
            this.broadcastUserList();
        }
    }

    public async handleEdit(senderConnectionId: string, operation: EditOperation) {
        const sender = this.connections.get(senderConnectionId);
        if (!sender) return;

        // --- (Previous Permission/Chat logic remains same) ---
        if (operation.type === 'update' && (sender.role === 'viewer' || sender.role === 'commenter')) return;
        if (operation.type === 'chat' && sender.role === 'viewer') return;

        const messageToSend = JSON.stringify({ ...operation, userId: sender.userId });

        if (operation.type === 'typing') { this.broadcast(senderConnectionId, messageToSend); return; }
        
        if (operation.type === 'chat' && operation.message) {
            const chatEntry = { id: Date.now(), user: sender.userId, message: operation.message, quote: operation.quote || null, color: sender.color, timestamp: Date.now() };
            await this.redisClient.rpush(`chat:${this.documentId}`, JSON.stringify(chatEntry));
            this.broadcastChatHistory();
            return;
        }

        if (operation.type === 'delete_chat' && operation.chatId) {
            const history = await this.redisClient.lrange(`chat:${this.documentId}`, 0, -1);
            const newHistory = history.filter(item => JSON.parse(item).id !== operation.chatId);
            await this.redisClient.del(`chat:${this.documentId}`);
            if (newHistory.length > 0) await this.redisClient.rpush(`chat:${this.documentId}`, ...newHistory);
            this.broadcastChatHistory();
            return;
        }

        if (operation.type === 'fetch_history') {
            const history = await this.redisClient.lrange(`history:${this.documentId}`, 0, 50); 
            const parsedHistory = history.map(h => JSON.parse(h));
            const user = this.connections.get(senderConnectionId);
            if (user && user.socket.readyState === WebSocket.OPEN) {
                user.socket.send(JSON.stringify({ type: 'history_list', list: parsedHistory }));
            }
            return;
        }

        if (operation.type === 'restore' && operation.content) {
            await this.redisClient.set(`doc:${this.documentId}`, operation.content);
            const snapshot = JSON.stringify({ timestamp: Date.now(), content: operation.content, user: sender.userId, note: 'Restored' });
            await this.redisClient.lpush(`history:${this.documentId}`, snapshot);
            await this.redisClient.set(`doc_last_version_time:${this.documentId}`, Date.now()); // Reset timer
            const restoreMsg = JSON.stringify({ type: 'update', content: operation.content, userId: 'SYSTEM' });
            this.broadcast('SYSTEM', restoreMsg);
            return;
        }

        // 🟢 FIXED: ATOMIC 10-MINUTE THROTTLE
        if (operation.type === 'update' && operation.content) {
            // 1. Live Sync (Instant)
            this.broadcast(senderConnectionId, messageToSend);
            
            // 2. Save Content (Instant)
            await this.redisClient.set(`doc:${this.documentId}`, operation.content);

            // 3. History Logic (With Lock)
            const now = Date.now();
            const lastVersionTimeStr = await this.redisClient.get(`doc_last_version_time:${this.documentId}`);
            const lastVersionTime = lastVersionTimeStr ? parseInt(lastVersionTimeStr, 10) : 0;
            const TEN_MINUTES = 600000;

            if (now - lastVersionTime > TEN_MINUTES) {
                // Try to acquire a lock for 5 seconds to prevent concurrent saves
                const lockKey = `history_lock:${this.documentId}`;
                const acquiredLock = await this.redisClient.set(lockKey, 'locked', 'EX', 5, 'NX');

                if (acquiredLock) {
                    console.log(`[History] Saving new snapshot for ${this.documentId}`);
                    
                    const snapshot = JSON.stringify({ 
                        timestamp: now, 
                        content: operation.content, 
                        user: sender.userId 
                    });
                    
                    await this.redisClient.lpush(`history:${this.documentId}`, snapshot);
                    await this.redisClient.ltrim(`history:${this.documentId}`, 0, 50); 
                    
                    // Update the time so next check fails
                    await this.redisClient.set(`doc_last_version_time:${this.documentId}`, now);
                }
            }
        }

        if (operation.type === 'cursor') {
            this.broadcast(senderConnectionId, messageToSend);
        }
    }

    private broadcastUserList() {
        const uniqueUsers = new Map<string, string>();
        this.connections.forEach(state => { uniqueUsers.set(state.userId, state.color); });
        const activeUsers = Array.from(uniqueUsers.entries()).map(([userId, color]) => ({ userId, color }));
        const msg = JSON.stringify({ type: 'user_list', list: activeUsers });
        this.connections.forEach((state) => { if (state.socket.readyState === WebSocket.OPEN) state.socket.send(msg); });
    }

    private async sendChatHistory(socket: WebSocket) {
        const chatHistory = await this.redisClient.lrange(`chat:${this.documentId}`, 0, -1);
        const parsedChat = chatHistory.map(c => JSON.parse(c));
        socket.send(JSON.stringify({ type: 'chat_history', list: parsedChat }));
    }

    private async broadcastChatHistory() {
        const history = await this.redisClient.lrange(`chat:${this.documentId}`, 0, -1);
        const parsedChat = history.map(c => JSON.parse(c));
        const msg = JSON.stringify({ type: 'chat_history', list: parsedChat });
        this.connections.forEach((state) => { if (state.socket.readyState === WebSocket.OPEN) state.socket.send(msg); });
    }

    private broadcast(senderConnectionId: string, message: string) {
        this.connections.forEach((state, connectionId) => {
            if (connectionId !== senderConnectionId && state.socket.readyState === WebSocket.OPEN) {
                state.socket.send(message);
            }
        });
    }
}