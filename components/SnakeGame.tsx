import React, { useEffect, useRef, useState, useCallback } from 'react';
import { GameState, Direction, Position, MotionVector, LiveConnectionState, ScoreEntry } from '../types';
import { detectMotion } from '../utils/visionUtils';
import { GeminiLiveService } from '../services/liveApiService';
import { blobToBase64 } from '../utils/audioUtils';

const INITIAL_SNAKE = [{ x: 10, y: 10 }];
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
          name: playerName || 'Unknown Pilot',
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
       alert("Please enter a name");
       return;
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
            // We use a Dead Zone of 0.3 to prevent accidental turns
            const THRESHOLD = 0.3; 
            
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
    const INITIAL_SNAKE_SPEED = 150;
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
        // Head is different color
        if (index === 0) {
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = '#ffffff';
        } else {
            ctx.fillStyle = '#00ffcc';
            ctx.shadowColor = '#00ffcc';
        }
        
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

  return (
    <div className="flex flex-col items-center justify-center retro-grid w-full h-screen relative">
      
      {/* Background Video Feed (Mirrored via CSS) */}
      <video 
        ref={videoRef} 
        autoPlay 
        muted 
        playsInline 
        className="absolute inset-0 w-full h-full video-bg"
      />

      {/* Motion Analysis Canvas (Hidden) */}
      <canvas ref={motionCanvasRef} width={320} height={240} className="hidden" />

      {/* Main Game UI */}
      <div className="z-10 flex flex-col items-center gap-4 p-4 w-full" style={{ maxWidth: '800px' }}>
        
        {/* Header / Score */}
        <div className="flex justify-between items-center w-full" style={{ marginBottom: '10px' }}>
            <div>
                <h1 className="text-title">NEON SNAKE</h1>
                <p className="font-mono" style={{ color: 'var(--color-secondary)' }}>
                    PILOT: {playerName || 'UNREGISTERED'}
                </p>
            </div>
            <div className="text-center">
                 <div style={{ fontSize: '0.8rem', color: '#888' }}>SCORE</div>
                 <div className="neon-text" style={{ fontSize: '3rem', fontWeight: 'bold' }}>{score}</div>
            </div>
        </div>

        {/* Game Container */}
        <div className="relative glass-panel" style={{ padding: '4px', display: 'inline-block' }}>
            <canvas 
                ref={gameCanvasRef} 
                width={Math.min(window.innerWidth - 32, 600)} 
                height={Math.min(window.innerWidth - 32, 600) * (ROWS/COLS)} 
                className="game-canvas"
            />
            
            {/* Gesture Feedback Radar (HUD) */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                 {/* Center Deadzone Marker */}
                 <div style={{ 
                     width: '80px', height: '80px', 
                     border: '1px dashed rgba(255,255,255,0.2)', 
                     borderRadius: '50%', 
                     position: 'absolute',
                     display: 'flex', alignItems: 'center', justifyContent: 'center'
                 }}>
                    <div style={{ width: '4px', height: '4px', background: 'rgba(255,255,255,0.5)', borderRadius: '50%' }}></div>
                 </div>
                 
                 {/* Detected Motion Indicator (Joystick style) */}
                 {/* Note: We don't invert X here because detectMotion already handles the logic. 
                     If detectMotion says X=1, that means RIGHT, so we move indicator RIGHT. */}
                 <div 
                    style={{
                        position: 'absolute',
                        width: '20px', height: '20px',
                        borderRadius: '50%',
                        background: 'rgba(0, 255, 204, 0.5)',
                        border: '2px solid #00ffcc',
                        boxShadow: '0 0 10px #00ffcc',
                        transform: `translate(${debugVector.x * 100}px, ${debugVector.y * 100}px)`,
                        opacity: debugVector.intensity > 0 ? 1 : 0.2,
                        transition: 'transform 0.1s linear'
                    }}
                 ></div>
                 
                 {/* Direction Text Overlay */}
                 {gameState === GameState.PLAYING && (
                     <div style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(0,0,0,0.7)', padding: '5px 10px', borderRadius: '4px', fontFamily: 'monospace', fontSize: '12px', color: '#00ffcc' }}>
                         CMD: {directionRef.current}
                     </div>
                 )}
            </div>

            {/* START SCREEN OVERLAY */}
            {gameState === GameState.IDLE && (
                <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ background: 'rgba(5, 5, 5, 0.85)', backdropFilter: 'blur(5px)', zIndex: 20 }}>
                    <div style={{ width: '100%', maxWidth: '300px', textAlign: 'center' }}>
                        <label style={{ display: 'block', color: 'var(--color-secondary)', marginBottom: '10px', fontFamily: 'Orbitron', letterSpacing: '2px' }}>
                            ENTER PILOT ID
                        </label>
                        <input 
                            type="text" 
                            value={playerName}
                            onChange={(e) => setPlayerName(e.target.value)}
                            className="cyber-input"
                            placeholder="PLAYER 1"
                            maxLength={10}
                        />
                        
                        <button 
                            onClick={startGame}
                            disabled={!playerName.trim()}
                            className="cyber-btn"
                        >
                            INITIATE SYSTEM
                        </button>

                        <div style={{ marginTop: '20px', fontSize: '0.8rem', color: '#666' }}>
                            <p>INSTRUCTIONS:</p>
                            <p style={{ color: '#00ffcc' }}>MOVE BODY TO STEER</p>
                            <p>CENTER = NEUTRAL</p>
                        </div>
                    </div>
                </div>
            )}

            {/* GAME OVER & LEADERBOARD OVERLAY */}
            {gameState === GameState.GAME_OVER && (
                <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ background: 'rgba(5, 5, 5, 0.95)', zIndex: 20 }}>
                    <h2 className="text-title" style={{ color: 'var(--color-accent)', marginBottom: '0' }}>GAME OVER</h2>
                    <p style={{ fontSize: '1.5rem', fontFamily: 'Orbitron', marginBottom: '20px' }}>
                        SCORE: <span style={{ color: 'var(--color-primary)' }}>{score}</span>
                    </p>
                    
                    {/* Leaderboard Table */}
                    <div className="glass-panel" style={{ width: '80%', maxWidth: '300px', padding: '15px', marginBottom: '20px' }}>
                        <h3 style={{ color: 'var(--color-secondary)', borderBottom: '1px solid #333', paddingBottom: '5px', marginTop: 0, fontSize: '0.9rem', letterSpacing: '2px' }}>
                            HIGH SCORES
                        </h3>
                        <div style={{ maxHeight: '150px', overflowY: 'auto' }}>
                            {leaderboard.map((entry, i) => (
                                <div key={entry.timestamp + i} className={`leaderboard-row ${entry.score === score && entry.name === playerName ? 'highlight' : ''}`}>
                                    <span>#{i+1} {entry.name}</span>
                                    <span>{entry.score}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <button 
                        onClick={startGame}
                        className="cyber-btn"
                        style={{ width: 'auto', padding: '10px 40px' }}
                    >
                        RETRY
                    </button>
                </div>
            )}
        </div>

        {/* Footer: Status */}
        <div className="status-badge">
            <div className={`status-dot ${liveState.isConnected ? 'dot-green' : liveState.isConnecting ? 'dot-yellow' : 'dot-red'}`}></div>
            <span>AI LINK: {liveState.isConnected ? 'ESTABLISHED' : liveState.isConnecting ? 'CONNECTING...' : 'OFFLINE'}</span>
        </div>
        
        {!liveState.isConnected && !liveState.isConnecting && (
             <div style={{ fontSize: '10px', color: '#555', maxWidth: '400px', textAlign: 'center' }}>
                 Note: Check API Key and Permissions for commentary.
             </div>
        )}
      </div>
    </div>
  );
};