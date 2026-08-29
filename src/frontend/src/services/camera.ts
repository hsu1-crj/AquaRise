import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 摄像头工具：封装 getUserMedia 的打开/关闭与帧抓拍。
 * 供登录页「人脸识别登录」与个人中心「人脸注册」复用。
 * 注意：getUserMedia 需 localhost 或 HTTPS 环境（npm run dev:5173 满足）。
 */

export interface CameraController {
  /** 摄像头是否已就绪且播放中 */
  ready: boolean;
  /** 打开摄像头（无权限/无设备时抛错） */
  open: () => Promise<void>;
  /** 停止摄像头并释放设备 */
  stop: () => void;
  /** 抓一拍当前帧为 JPEG File（需 ready=true） */
  capture: () => File;
  /** 摄像头视频元素 ref，绑定到 <video ref=... muted /> */
  videoRef: React.RefObject<HTMLVideoElement>;
}

export function useCamera(): CameraController {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setReady(false);
  }, []);

  const open = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头访问');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      stop(); // 关闭可能残留的旧流
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      setReady(true);
    } catch (reason) {
      const name = reason instanceof DOMException ? reason.name : '';
      if (name === 'NotAllowedError') throw new Error('摄像头权限被拒绝，请在浏览器设置中允许访问');
      if (name === 'NotFoundError') throw new Error('未检测到可用摄像头');
      throw new Error(reason instanceof Error ? reason.message : '无法打开摄像头');
    }
  }, [stop]);

  const capture = useCallback((): File => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) throw new Error('摄像头尚未就绪，请稍后重试');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法读取摄像头画面');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = canvas.toDataURL('image/jpeg', 0.92);
    const bytes = atob(blob.split(',')[1]);
    const u8 = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) u8[i] = bytes.charCodeAt(i);
    return new File([u8], 'face.jpg', { type: 'image/jpeg' });
  }, []);

  // 组件卸载时释放摄像头
  useEffect(() => stop, [stop]); 

  return { ready, open, stop, capture, videoRef: videoRef as React.RefObject<HTMLVideoElement> };
}
