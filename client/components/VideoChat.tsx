'use client';

import { useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

type Status = 'idle' | 'searching' | 'connected' | 'error' | 'disconnected';

const emitWithAck = <T,>(socket: Socket, event: string, ...args: any[]): Promise<T> => {
    return new Promise((resolve) => {
        socket.emit(event, ...args, (response: T) => resolve(response));
    });
};

export default function VideoChat() {
    const [status, setStatus] = useState<Status>('idle');
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);

    const connectionState = useRef<{
        socket: Socket | null;
        device: mediasoupClient.Device | null;
        localStream: MediaStream | null;
        sendTransport: mediasoupClient.types.Transport | null;
        recvTransport: mediasoupClient.types.Transport | null;
        videoProducer: mediasoupClient.types.Producer | null;
        audioProducer: mediasoupClient.types.Producer | null;
        consumers: Map<string, mediasoupClient.types.Consumer>;
        roomName: string | null;
    }>({
        socket: null, device: null, localStream: null, sendTransport: null, recvTransport: null,
        videoProducer: null, audioProducer: null, consumers: new Map(), roomName: null,
    });
    
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);

    const cleanup = () => {
        connectionState.current.consumers.forEach(consumer => consumer.close());
        connectionState.current.sendTransport?.close();
        connectionState.current.recvTransport?.close();
        connectionState.current.localStream?.getTracks().forEach(track => track.stop());
        connectionState.current.socket?.disconnect();
        
        connectionState.current = {
            socket: null, device: null, localStream: null, sendTransport: null, recvTransport: null,
            videoProducer: null, audioProducer: null, consumers: new Map(), roomName: null,
        };

        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        if (localVideoRef.current) localVideoRef.current.srcObject = null;
    };

    const connect = async () => {
        cleanup();
        setStatus('searching');

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            connectionState.current.localStream = stream;
            if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        } catch (err) {
            console.error('Error getting user media:', err);
            setStatus('error');
            return;
        }

        const socket = io(process.env.NEXT_PUBLIC_SIGNALING_SERVER_URL!);
        connectionState.current.socket = socket;

        socket.on('connect', () => {
            emitWithAck<{ status: string }>(socket, 'join');
        });

        socket.on('matched', async ({ roomName }: { roomName: string }) => {
            setStatus('connected');
            connectionState.current.roomName = roomName;
            
            try {
                const routerRtpCapabilities = await emitWithAck<mediasoupClient.types.RtpCapabilities>(socket, 'getRouterRtpCapabilities', { roomName });
                const device = new mediasoupClient.Device();
                await device.load({ routerRtpCapabilities });
                connectionState.current.device = device;

                const sendTransportInfo = await emitWithAck<any>(socket, 'createWebRtcTransport', { roomName, isProducer: true });
                if (sendTransportInfo.error) throw new Error(sendTransportInfo.error);
                const sendTransport = device.createSendTransport(sendTransportInfo);
                sendTransport.on('connect', ({ dtlsParameters }, cb) => { emitWithAck(socket, 'connectTransport', { transportId: sendTransport.id, dtlsParameters }).then(cb); });
                sendTransport.on('produce', async ({ kind, rtpParameters, appData }, cb) => {
                    const { id } = await emitWithAck<{ id: string }>(socket, 'produce', { transportId: sendTransport.id, kind, rtpParameters, appData });
                    cb({ id });
                });
                connectionState.current.sendTransport = sendTransport;
                
                const stream = connectionState.current.localStream;
                if (stream) {
                    const videoTrack = stream.getVideoTracks()[0];
                    if(videoTrack) connectionState.current.videoProducer = await sendTransport.produce({ track: videoTrack });
                    const audioTrack = stream.getAudioTracks()[0];
                    if(audioTrack) connectionState.current.audioProducer = await sendTransport.produce({ track: audioTrack });
                }

                const recvTransportInfo = await emitWithAck<any>(socket, 'createWebRtcTransport', { roomName, isProducer: false });
                if (recvTransportInfo.error) throw new Error(recvTransportInfo.error);
                const recvTransport = device.createRecvTransport(recvTransportInfo);
                recvTransport.on('connect', ({ dtlsParameters }, cb) => { emitWithAck(socket, 'connectTransport', { transportId: recvTransport.id, dtlsParameters }).then(cb); });
                connectionState.current.recvTransport = recvTransport;

            } catch(err) {
                console.error("Error during connection setup:", err);
                setStatus('error');
                cleanup();
            }
        });

        socket.on('new-producer', async ({ producerId }) => {
            const { device, recvTransport, roomName } = connectionState.current;
            if (!device || !recvTransport || !roomName) return;

            const consumerData = await emitWithAck<any>(socket, 'consume', { roomName, producerId, rtpCapabilities: device.rtpCapabilities });
            if (consumerData.error) return console.error('Failed to create consumer:', consumerData.error);
            
            const consumer = await recvTransport.consume(consumerData);
            connectionState.current.consumers.set(consumer.id, consumer);

            const remoteStream = new MediaStream([consumer.track]);
            if(remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;

            emitWithAck(socket, 'resume-consumer', { consumerId: consumer.id });
        });

        socket.on('peer-disconnected', () => {
            setStatus('disconnected');
            if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
            setTimeout(() => { connect(); }, 3000);
        });

        socket.on('disconnect', () => {
            setStatus('disconnected');
            cleanup();
        });
    };
    
    const toggleMute = () => {
        const { audioProducer } = connectionState.current;
        if (audioProducer && audioProducer.track) {
            audioProducer.track.enabled = !audioProducer.track.enabled;
            setIsMuted(!audioProducer.track.enabled);
        }
    };

    const toggleVideo = () => {
        const { videoProducer } = connectionState.current;
        if (videoProducer && videoProducer.track) {
            videoProducer.track.enabled = !videoProducer.track.enabled;
            setIsVideoOff(!videoProducer.track.enabled);
        }
    };

    const renderStatus = () => {
        switch (status) {
            case 'searching': return <p>🔎 Searching for a partner...</p>;
            case 'connected': return <p className="text-green-400">✅ Connected</p>;
            case 'disconnected': return <p className="text-yellow-400">👋 Partner disconnected. Finding a new one...</p>;
            case 'error': return <p className="text-red-500">❌ Error. Please check permissions and try again.</p>;
            default: return null;
        }
    };

    return (
        <div className="w-full max-w-5xl p-4 flex flex-col items-center">
            {status === 'idle' ? (
                <div className="flex flex-col items-center justify-center h-96">
                    <h2 className="text-3xl font-semibold mb-4">Ready to Chat?</h2>
                    <p className="text-gray-400 mb-8">Click "Start" to find a random partner.</p>
                    <button onClick={connect} className="px-8 py-3 bg-indigo-600 text-white font-bold rounded-full hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-indigo-500 transition-transform transform hover:scale-105">Start</button>
                </div>
            ) : (
                <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden shadow-2xl">
                    <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
                    <div className="absolute top-4 left-4 z-10 bg-black/50 p-2 rounded">{renderStatus()}</div>
                    <video ref={localVideoRef} autoPlay playsInline muted className="absolute bottom-4 right-4 w-1/4 max-w-[200px] aspect-video bg-gray-800 rounded-md border-2 border-gray-600 shadow-lg" />
                </div>
            )}
            
            {(status === 'connected') && (
                <div className="mt-6 flex items-center space-x-4">
                    <button onClick={toggleMute} aria-pressed={isMuted} aria-label={isMuted ? "Unmute" : "Mute"} className="p-3 bg-gray-700 rounded-full hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-white aria-pressed:bg-red-600">{isMuted ? '🔇' : '🎤'}</button>
                    <button onClick={toggleVideo} aria-pressed={isVideoOff} aria-label={isVideoOff ? "Enable video" : "Disable video"} className="p-3 bg-gray-700 rounded-full hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-white aria-pressed:bg-red-600">{isVideoOff ? '📷' : '📹'}</button>
                    <button onClick={connect} className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-full hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-blue-500">Next</button>
                </div>
            )}
        </div>
    );
}