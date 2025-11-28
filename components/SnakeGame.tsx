import React, { useEffect, useRef, useState, useCallback } from 'react';
import { GameState, Direction, Position, MotionVector, LiveConnectionState, ScoreEntry } from '../types';
import { detectMotion } from '../utils/visionUtils';
import { GeminiLiveService } from '../services/liveApiService';
import { blobToBase64 } from '../utils/audioUtils';

const GRID_SIZE = 20;
const INITIAL_SNAKE = [{ x: 10, y: 10 }];
const INITIAL_SPEED = 150;
const LEADERBOARD_KEY = 'neon_snake_leaderboard';

export const SnakeGame: React.FC = () => {
  // Game State
  const [gameState, setGameState] = useState<GameState>(GameState.IDLE);
  const [score, setScore] = useState(0);
  const [debugVector, setDebugVector] = useState<MotionVector>({ x: 0, y: 0, intensity: 0 });
  const [liveState, setLiveState] = useState<LiveConnectionState>({ isConnected: false, isConnecting: false, error: null });
  
  // Player & Leaderboard State
  const [playerName, setPlayerName] = useState('');
  const [leaderboard, setLeaderboard] = useState<ScoreEntry[]>([]);
  const [isLeaderboardOpen, setIsLeaderboardOpen] = useState(false);

  // Refs for mutable game data
  const snakeRef = useRef<Position[]>(INITIAL_SNAKE);
  const foodRef = useRef<Position>({ x: 15, y: 5 });
  const directionRef = useRef<Direction>(Direction.RIGHT);
  const gameLoopRef = useRef<number | null>(null);
  const lastUpdateRef = useRef<number>(0);
  const smoothedVectorRef = useRef<{x: number, y: number}>({x: 0, y:0});
  
  // HTML Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const motionCanvasRef = useRef<HTMLCanvasElement>(null);
  const gameCanvasRef = useRef<HTMLCanvasElement>(null);
  const liveServiceRef = useRef<GeminiLiveService | null>(null);

  // Load Leaderboard on mount
  useEffect(() => {
    const saved = localStorage.getItem(LEADERBOARD_KEY);
    if (saved) {
        try {
            setLeaderboard(JSON.parse(saved));
        } catch (e) {
            console.error("Failed to parse leaderboard");
        }
    }

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                width: { ideal: 320 }, 
                height: { ideal: 240 },
                facingMode: 'user'
            } 
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error("Error accessing webcam:", err);
      }
    };
    startCamera();

    return () => {
       if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
    };
  }, []);

  const saveScore = (finalScore: number) => {
      const entry: ScoreEntry = {
          name: playerName || 'Anonymous',
          score: finalScore,
          timestamp: Date.now()
      };
      
      const newLeaderboard = [...leaderboard, entry]
        .sort((a, b) => b.score - a.score)
        .slice(0, 10); // Keep top 10
      
      setLeaderboard(newLeaderboard);
      localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(newLeaderboard));
  };

  const startGame = async () => {
    if (!process.env.API_KEY) {
        alert("API_KEY missing in environment variables");
        return;
    }
    
    if (!playerName.trim()) {
        const name = prompt("Enter Pilot Name:", "Player 1");
        if (name) setPlayerName(name);
        else setPlayerName("Player 1");
    }

    setGameState(GameState.PLAYING);
    setScore(0);
    snakeRef.current = [...INITIAL_SNAKE];
    directionRef.current = Direction.RIGHT;
    smoothedVectorRef.current = { x: 0, y: 0 };
    spawnFood();
    
    // Connect Gemini Live if not already
    if (!liveServiceRef.current) {
        setLiveState(prev => ({ ...prev, isConnecting: true }));
        const service = new GeminiLiveService(process.env.API_KEY);
        liveServiceRef.current = service;
        
        await service.connect(
            (msg) => console.log("Gemini:", msg),
            (status) => {
                setLiveState({ 
                    isConnected: status === 'connected', 
                    isConnecting: false, 
                    error: status === 'error' ? 'Connection Failed' : null 
                });
            }
        );
    }
  };

  const spawnFood = () => {
    const x = Math.floor(Math.random() * (window.innerWidth < 600 ? 15 : 30)); 
    const y = Math.floor(Math.random() * (window.innerWidth < 600 ? 15 : 20));
    foodRef.current = { x, y };
  };

  // The Main Loop
  const loop = useCallback((timestamp: number) => {
    if (gameState !== GameState.PLAYING) return;

    // 1. Handle Motion Detection (Every Frame)
    if (videoRef.current && motionCanvasRef.current) {
        const ctx = motionCanvasRef.current.getContext('2d', { willReadFrequently: true });
        if (ctx && videoRef.current.readyState === 4) {
            const w = motionCanvasRef.current.width;
            const h = motionCanvasRef.current.height;
            
            // Draw video to invisible canvas for analysis
            ctx.drawImage(videoRef.current, 0, 0, w, h);
            
            // Get Motion Vector
            const rawVector = detectMotion(ctx, w, h);
            
            // Smoothing (Linear Interpolation)
            // vector = prev * 0.8 + new * 0.2
            smoothedVectorRef.current.x = smoothedVectorRef.current.x * 0.8 + rawVector.x * 0.2;
            smoothedVectorRef.current.y = smoothedVectorRef.current.y * 0.8 + rawVector.y * 0.2;
            
            const smoothed = {
                x: smoothedVectorRef.current.x,
                y: smoothedVectorRef.current.y,
                intensity: rawVector.intensity
            };
            
            setDebugVector(smoothed);

            // Determine Direction from Smoothed Vector
            // We use a Dead Zone of 0.2
            const THRESHOLD = 0.2; 
            
            // To prevent rapid switching, we prioritize the dominant axis
            if (Math.abs(smoothed.x) > Math.abs(smoothed.y)) {
                // Moving Horizontally
                if (Math.abs(smoothed.x) > THRESHOLD) {
                    if (smoothed.x > 0 && directionRef.current !== Direction.LEFT) directionRef.current = Direction.RIGHT;
                    if (smoothed.x < 0 && directionRef.current !== Direction.RIGHT) directionRef.current = Direction.LEFT;
                }
            } else {
                // Moving Vertically
                if (Math.abs(smoothed.y) > THRESHOLD) {
                    if (smoothed.y > 0 && directionRef.current !== Direction.UP) directionRef.current = Direction.DOWN; 
                    if (smoothed.y < 0 && directionRef.current !== Direction.DOWN) directionRef.current = Direction.UP;
                }
            }

            // Stream to Gemini (Throttle to ~2 FPS)
            if (Math.floor(timestamp / 500) % 2 === 0 && liveServiceRef.current) {
                 motionCanvasRef.current.toBlob(async (blob) => {
                    if (blob) {
                        const base64 = await blobToBase64(blob);
                        liveServiceRef.current?.sendVideoFrame(base64);
                    }
                 }, 'image/jpeg', 0.5);
            }
        }
    }

    // 2. Update Snake Logic (Fixed Time Step)
    if (timestamp - lastUpdateRef.current > INITIAL_SNAKE_SPEED) {
        updateSnake();
        lastUpdateRef.current = timestamp;
    }

    // 3. Render Game
    renderGame();

    gameLoopRef.current = requestAnimationFrame(loop);
  }, [gameState]);

  // Adjust Grid size based on screen
  const COLS = window.innerWidth < 640 ? 15 : 30;
  const ROWS = window.innerWidth < 640 ? 15 : 20;
  
  // Game Logic Helper
  const updateSnake = () => {
    const head = { ...snakeRef.current[0] };

    switch (directionRef.current) {
        case Direction.UP: head.y -= 1; break;
        case Direction.DOWN: head.y += 1; break;
        case Direction.LEFT: head.x -= 1; break;
        case Direction.RIGHT: head.x += 1; break;
    }

    // Wall Collision
    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
        gameOver();
        return;
    }

    // Self Collision
    if (snakeRef.current.some(segment => segment.x === head.x && segment.y === head.y)) {
        gameOver();
        return;
    }

    const newSnake = [head, ...snakeRef.current];

    // Food Collision
    if (head.x === foodRef.current.x && head.y === foodRef.current.y) {
        setScore(s => s + 1);
        spawnFood();
    } else {
        newSnake.pop();
    }

    snakeRef.current = newSnake;
  };

  const gameOver = () => {
    setGameState(GameState.GAME_OVER);
    saveScore(score);
    if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
  };

  const renderGame = () => {
    const cvs = gameCanvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.clearRect(0, 0, cvs.width, cvs.height);

    const cellSize = cvs.width / COLS;

    // Draw Grid (Subtle)
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    for(let i=0; i<=COLS; i++) {
        ctx.beginPath(); ctx.moveTo(i*cellSize, 0); ctx.lineTo(i*cellSize, cvs.height); ctx.stroke();
    }
    for(let i=0; i<=ROWS; i++) {
        ctx.beginPath(); ctx.moveTo(0, i*cellSize); ctx.lineTo(cvs.width, i*cellSize); ctx.stroke();
    }

    // Draw Food
    ctx.fillStyle = '#ff0055';
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#ff0055';
    const fx = foodRef.current.x * cellSize;
    const fy = foodRef.current.y * cellSize;
    ctx.fillRect(fx + 2, fy + 2, cellSize - 4, cellSize - 4);
    ctx.shadowBlur = 0;

    // Draw Snake
    ctx.fillStyle = '#00ffcc';
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#00ffcc';
    snakeRef.current.forEach((seg, index) => {
        const x = seg.x * cellSize;
        const y = seg.y * cellSize;
        if (index === 0) ctx.fillStyle = '#e0ffff';
        else ctx.fillStyle = '#00ffcc';
        
        ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
    });
    ctx.shadowBlur = 0;
  };

  // Start/Stop Loop
  useEffect(() => {
    if (gameState === GameState.PLAYING) {
        gameLoopRef.current = requestAnimationFrame(loop);
    }
    return () => {
        if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
    }
  }, [gameState, loop]);

  const INITIAL_SNAKE_SPEED = 150; // ms per move

  return (
    <div className="relative w-full h-screen flex flex-col items-center justify-center retro-grid">
      
      {/* Background Video Feed (Mirrored) */}
      <video 
        ref={videoRef} 
        autoPlay 
        muted 
        playsInline 
        className="absolute top-0 left-0 w-full h-full object-cover opacity-20 transform -scale-x-100 pointer-events-none"
      />

      {/* Motion Analysis Canvas (Hidden logic) */}
      <canvas ref={motionCanvasRef} width={320} height={240} className="hidden" />

      {/* Main Game UI */}
      <div className="z-10 flex flex-col items-center gap-4 p-4 w-full max-w-4xl">
        
        {/* Header / Score */}
        <div className="flex justify-between w-full max-w-2xl items-end mb-2">
            <div>
                <h1 className="text-4xl font-black italic tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-600 neon-text">
                    NEON SNAKE
                </h1>
                <p className="text-xs text-cyan-300/70 font-mono">
                    PILOT: {playerName || 'UNREGISTERED'}
                </p>
            </div>
            <div className="text-right">
                 <div className="text-xs text-cyan-300/70 font-mono">SCORE</div>
                 <div className="text-4xl font-bold text-white neon-text">{score}</div>
            </div>
        </div>

        {/* Game Container */}
        <div className="relative border-2 border-cyan-500/50 rounded-lg shadow-[0_0_30px_rgba(0,255,255,0.3)] bg-black/80 backdrop-blur-sm overflow-hidden">
            <canvas 
                ref={gameCanvasRef} 
                width={Math.min(window.innerWidth - 32, 600)} 
                height={Math.min(window.innerWidth - 32, 600) * (ROWS/COLS)} 
                className="block"
            />
            
            {/* Improved Gesture Feedback Radar */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                 {/* Center Deadzone Marker */}
                 <div className="w-16 h-16 border border-white/10 rounded-full absolute flex items-center justify-center">
                    <div className="w-1 h-1 bg-white/40 rounded-full"></div>
                 </div>
                 
                 {/* Detected Motion Indicator (Joystick style) */}
                 <div 
                    className="w-6 h-6 border-2 border-cyan-400 bg-cyan-400/20 rounded-full absolute transition-transform duration-75 flex items-center justify-center shadow-[0_0_10px_cyan]"
                    style={{
                        transform: `translate(${-debugVector.x * 100}px, ${debugVector.y * 100}px)`, // Invert X for mirror feel
                        opacity: debugVector.intensity > 0 ? 1 : 0.2
                    }}
                 >
                    <div className="w-1 h-1 bg-cyan-200 rounded-full"></div>
                 </div>
                 
                 {/* Direction Text */}
                 {gameState === GameState.PLAYING && (
                     <div className="absolute top-4 right-4 bg-black/50 px-2 py-1 rounded text-cyan-400 font-mono text-xs border border-cyan-900">
                         VECTOR: [{(-debugVector.x).toFixed(2)}, {debugVector.y.toFixed(2)}]<br/>
                         DIR: {directionRef.current}
                     </div>
                 )}
            </div>

            {/* START SCREEN */}
            {gameState === GameState.IDLE && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 backdrop-blur-md p-6">
                    <div className="w-full max-w-xs space-y-4">
                        <label className="block text-cyan-300 font-mono text-sm uppercase tracking-wider">Pilot Name</label>
                        <input 
                            type="text" 
                            value={playerName}
                            onChange={(e) => setPlayerName(e.target.value)}
                            className="w-full bg-black/50 border border-cyan-500 text-white p-3 text-center text-xl font-bold focus:outline-none focus:ring-2 focus:ring-cyan-400 uppercase placeholder-cyan-800"
                            placeholder="ENTER NAME"
                            maxLength={10}
                        />
                        
                        <button 
                            onClick={startGame}
                            disabled={!playerName.trim()}
                            className="w-full group relative px-8 py-4 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-bold text-xl uppercase tracking-widest clip-path-polygon transition-all"
                            style={{ clipPath: 'polygon(5% 0, 100% 0, 100% 70%, 95% 100%, 0 100%, 0 30%)' }}
                        >
                            INITIATE LINK
                            <div className="absolute inset-0 bg-white/20 group-hover:animate-pulse"></div>
                        </button>

                        <div className="text-center mt-4">
                            <p className="text-cyan-200/60 text-xs">
                                MOVE HAND/BODY TO CONTROL<br/>
                                <span className="text-cyan-400">CENTER</span> = NEUTRAL
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* GAME OVER & LEADERBOARD */}
            {gameState === GameState.GAME_OVER && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 backdrop-blur-md p-4 animate-fadeIn">
                    <h2 className="text-5xl font-black text-red-500 mb-2 neon-text tracking-widest">TERMINATED</h2>
                    <p className="text-xl text-white mb-6 font-mono">SCORE: <span className="text-cyan-400 text-3xl">{score}</span></p>
                    
                    {/* Leaderboard Table */}
                    <div className="w-full max-w-xs bg-black/50 border border-white/10 rounded mb-6 p-4">
                        <h3 className="text-cyan-500 font-bold mb-3 text-sm tracking-widest border-b border-white/10 pb-2">TOP PILOTS</h3>
                        <div className="space-y-2 max-h-40 overflow-y-auto">
                            {leaderboard.map((entry, i) => (
                                <div key={entry.timestamp + i} className={`flex justify-between text-sm font-mono ${entry.timestamp === leaderboard[0].timestamp && score === entry.score ? 'text-yellow-400 animate-pulse' : 'text-gray-400'}`}>
                                    <span>#{i+1} {entry.name}</span>
                                    <span>{entry.score}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <button 
                        onClick={startGame}
                        className="px-8 py-3 border border-cyan-500 text-cyan-400 hover:bg-cyan-500 hover:text-black transition-colors font-bold uppercase tracking-wider"
                    >
                        Replay
                    </button>
                </div>
            )}
        </div>

        {/* Gemini Status Footer */}
        <div className="flex items-center gap-2 mt-4 px-4 py-2 rounded-full bg-black/40 border border-white/10">
            <div className={`w-2 h-2 rounded-full ${liveState.isConnected ? 'bg-green-500 animate-pulse' : liveState.isConnecting ? 'bg-yellow-500' : 'bg-red-500'}`}></div>
            <span className="text-xs font-mono text-gray-400 uppercase">
                CO-PILOT AI: {liveState.isConnected ? 'ONLINE' : liveState.isConnecting ? 'CONNECTING...' : 'OFFLINE'}
            </span>
        </div>
      </div>
    </div>
  );
};
