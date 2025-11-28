import { MotionVector } from '../types';

let prevFrame: Uint8ClampedArray | null = null;

// Returns a vector -1 to 1 for x and y based on where movement is occurring relative to center
export function detectMotion(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): MotionVector {
  // Use a slightly larger grid for better precision
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  
  // Sampling stride (smaller stride = more precision but more CPU)
  const stride = 8; 
  
  let totalX = 0;
  let totalY = 0;
  let changeCount = 0;
  
  if (prevFrame && prevFrame.length === data.length) {
    // Loop through pixels
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        const i = (y * width + x) * 4;
        
        // Calculate RGB difference
        const rDiff = Math.abs(data[i] - prevFrame[i]);
        const gDiff = Math.abs(data[i + 1] - prevFrame[i + 1]);
        const bDiff = Math.abs(data[i + 2] - prevFrame[i + 2]);
        
        // Combined intensity difference
        const diff = (rDiff + gDiff + bDiff) / 3;
        
        // Threshold to ignore camera noise
        if (diff > 25) { 
          changeCount++;
          // Accumulate the position of the change
          totalX += x;
          totalY += y;
        }
      }
    }
  }
  
  // Store current frame
  prevFrame = new Uint8ClampedArray(data);

  // Lower motion threshold for better responsiveness
  const motionThreshold = (width * height) / (stride * stride) * 0.001; 
  if (changeCount < motionThreshold) {
    return { x: 0, y: 0, intensity: 0 };
  }

  // Calculate Average Center of Motion
  const avgX = totalX / changeCount;
  const avgY = totalY / changeCount;

  // Calculate vector relative to the CENTER of the frame (width/2, height/2)
  const centerX = width / 2;
  const centerY = height / 2;

  // Normalize to -1...1
  // CRITICAL FIX: Webcams are mirrored. 
  // If I move Right (my physical right), the object moves to the Left of the pixel buffer.
  // So avgX < centerX. 
  // We want that to represent +1 (Right) for the game.
  // Old: (avgX - centerX) -> Negative result.
  // New: (centerX - avgX) -> Positive result.
  let normX = (centerX - avgX) / (centerX * 0.5); // 0.5 sensitivity (reach max speed at half screen)
  let normY = (avgY - centerY) / (centerY * 0.5);

  // Clamp values
  normX = Math.max(-1, Math.min(1, normX));
  normY = Math.max(-1, Math.min(1, normY));

  return { x: normX, y: normY, intensity: changeCount };
}