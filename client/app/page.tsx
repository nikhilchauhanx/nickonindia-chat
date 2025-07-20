import VideoChat from '../components/VideoChat';

export default function Home() {
  return (
    <main className="bg-gray-900 text-white min-h-screen flex flex-col items-center justify-center">
      <header className="absolute top-0 left-0 w-full p-4">
        <h1 className="text-2xl font-bold text-center text-gray-300">Random Video Chat</h1>
      </header>
      <VideoChat />
    </main>
  );
}