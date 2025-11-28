import { MotionVector } from '../types';

let prevFrame: Uint8ClampedArray | null = null;

// Returns a vector -1 to 1 for x and y based on where movement is occurring relative to center
export function detectMotion(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): MotionVector {
  // Use a slightly larger grid for better precision
  const scaledWidth = 100;
  const scaledHeight = 75;
  
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  
  // Sampling stride (smaller stride = more precision but more CPU)
  const stride = 4; 
  
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
        
        // Higher threshold to ignore camera noise (ISO grain)
        if (diff > 40) { 
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

  // If not enough movement, return zero vector (dead zone)
  const motionThreshold = (width * height) / (stride * stride) * 0.005; // 0.5% of pixels must move
  if (changeCount < motionThreshold) {
    return { x: 0, y: 0, intensity: 0 };
  }

  // Calculate Average Center of Motion
  const avgX = totalX / changeCount;
  const avgY = totalY / changeCount;

  // Calculate vector relative to the CENTER of the frame (width/2, height/2)
  // X is inverted because webcam is usually mirrored for the user
  const centerX = width / 2;
  const centerY = height / 2;

  // Normalize to -1...1
  // We divide by (width/2) so that the edge of screen is 1.0
  let normX = (avgX - centerX) / (centerX * 0.6); // 0.6 sensitivity factor (reach edge faster)
  let normY = (avgY - centerY) / (centerY * 0.6);

  // Clamp values
  normX = Math.max(-1, Math.min(1, normX));
  normY = Math.max(-1, Math.min(1, normY));

  return { x: normX, y: normY, intensity: changeCount };
}
