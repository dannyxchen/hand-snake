export enum GameState {
  IDLE = 'IDLE',
  PLAYING = 'PLAYING',
  GAME_OVER = 'GAME_OVER',
}

export interface Position {
  x: number;
  y: number;
}

export interface MotionVector {
  x: number;
  y: number;
  intensity: number;
}

export enum Direction {
  UP = 'UP',
  DOWN = 'DOWN',
  LEFT = 'LEFT',
  RIGHT = 'RIGHT',
}

export interface LiveConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
}

export interface ScoreEntry {
  name: string;
  score: number;
  timestamp: number;
}
