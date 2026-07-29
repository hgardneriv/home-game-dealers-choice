import { GameRoom } from '@/components/GameRoom';

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GameRoom gameId={id} />;
}
