import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import * as mediasoup from 'mediasoup';

const app = express();
const httpServer = http.createServer(app);

// --- State Management ---
let worker: mediasoup.types.Worker;
const rooms: Map<string, mediasoup.types.Router> = new Map();
const transports: Map<string, mediasoup.types.WebRtcTransport> = new Map();
const peerRooms: Map<string, string> = new Map();

// --- Redis Client ---
const pubClient = createClient({ url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}` });
const subClient = pubClient.duplicate();
const WAITING_POOL_KEY = 'waiting_pool';

// --- Mediasoup Worker ---
const createWorker = async () => {
    const w = await mediasoup.createWorker({
        rtcMinPort: 20000,
        rtcMaxPort: 20020,
    });
    w.on('died', () => {
        console.error('Mediasoup worker has died, exiting in 2 seconds...');
        setTimeout(() => process.exit(1), 2000);
    });
    return w;
};

// --- Main Server Logic ---
(async () => {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    worker = await createWorker();

    const io = new Server(httpServer, {
        cors: { origin: '*' },
        adapter: createAdapter(pubClient, subClient),
    });

    io.on('connection', async (socket: Socket) => {
        socket.on('join', async (callback) => {
            await pubClient.lPush(WAITING_POOL_KEY, socket.id);
            const waitingCount = await pubClient.lLen(WAITING_POOL_KEY);

            if (waitingCount >= 2) {
                const [peer1Id, peer2Id] = await Promise.all([
                    pubClient.rPop(WAITING_POOL_KEY),
                    pubClient.rPop(WAITING_POOL_KEY)
                ]);

                if (peer1Id && peer2Id) {
                    const roomName = `room-${peer1Id}-${peer2Id}`;
                    const router = await worker.createRouter({ mediaCodecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }, { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }] });
                    rooms.set(roomName, router);
                    [peer1Id, peer2Id].forEach(peerId => {
                        peerRooms.set(peerId, roomName);
                        io.to(peerId).emit('matched', { roomName });
                    });
                }
            } else {
                if (callback) callback({ status: 'waiting' });
            }
        });

        socket.on('getRouterRtpCapabilities', (data, callback) => {
            const router = rooms.get(data.roomName);
            if (router) callback(router.rtpCapabilities);
        });

        socket.on('createWebRtcTransport', async ({ roomName, isProducer }, callback) => {
            try {
                const router = rooms.get(roomName);
                if (!router) throw new Error(`Router not found for room: ${roomName}`);

                const transport = await router.createWebRtcTransport({
                    listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP }],
                    enableUdp: true, enableTcp: true, preferUdp: true,
                    appData: { socketId: socket.id, isProducer }
                });

                // Add the new transport to our map.
                transports.set(transport.id, transport);

                // When the transport's connection state changes, check if it's closed.
                transport.on('dtlsstatechange', (dtlsState) => {
                    if (dtlsState === 'closed') {
                        // If it's closed, remove it from our map.
                        transports.delete(transport.id);
                    }
                });

                callback({ id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters });
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Unknown error';
                callback({ error: message });
            }
        });
        socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
            const transport = transports.get(transportId);
            if (!transport) return callback({ error: 'Transport not found' });
            await transport.connect({ dtlsParameters });
            callback({ connected: true });
        });

        socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
            const transport = transports.get(transportId);
            if (!transport) return callback({ error: 'Transport not found' });
            const producer = await transport.produce({ kind, rtpParameters, appData });

            const roomName = peerRooms.get(socket.id);
            if (roomName) {
                socket.to(roomName).emit('new-producer', { producerId: producer.id });
            }
            callback({ id: producer.id });
        });

        socket.on('consume', async ({ roomName, producerId, rtpCapabilities }, callback) => {
            try {
                const router = rooms.get(roomName);
                if (!router || !router.canConsume({ producerId, rtpCapabilities })) {
                    throw new Error(`Cannot consume producer: ${producerId}`);
                }
                const transport = Array.from(transports.values()).find(t => t.appData.socketId === socket.id && !t.appData.isProducer);
                if (!transport) throw new Error('Receiving transport not found for this consumer');

                const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
                // No need to store consumers on server for 1-to-1

                callback({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
            } catch (e) {
                const message = e instanceof Error ? e.message : 'Unknown error';
                callback({ error: message });
            }
        });

        socket.on('resume-consumer', async ({ consumerId }) => {
            // This is a placeholder, in a real app you might need to find the consumer and resume it.
            // For this simple case, the client handles it.
        });

        socket.on('disconnect', async () => {
            console.log(`Socket disconnected: ${socket.id}`);
            await pubClient.lRem(WAITING_POOL_KEY, 1, socket.id);
            const roomName = peerRooms.get(socket.id);
            if (roomName) {
                socket.to(roomName).emit('peer-disconnected');
                peerRooms.delete(socket.id);
                // Simple cleanup, can be made more robust
            }
        });
    });

    const PORT = process.env.PORT || 4000;
    httpServer.listen(PORT, () => console.log(`🚀 Signaling server listening on port ${PORT}`));
})();