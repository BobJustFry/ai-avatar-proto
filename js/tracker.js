// Трекинг лица и сегментация. Всё считается локально в браузере (WASM/GPU),
// видео никуда не отправляется.
import {
  FilesetResolver, FaceLandmarker, ImageSegmenter,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const SEG_MODEL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

let fileset = null;
const getFileset = async () => (fileset ??= await FilesetResolver.forVisionTasks(WASM));

// GPU быстрее, но на части драйверов падает — тогда тихо уходим на CPU.
async function withDelegateFallback(create) {
  try {
    return await create("GPU");
  } catch (err) {
    console.warn("GPU delegate недоступен, переключаюсь на CPU:", err);
    return await create("CPU");
  }
}

export async function createFaceLandmarker() {
  const files = await getFileset();
  return withDelegateFallback((delegate) =>
    FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    }));
}

export async function createSegmenter() {
  const files = await getFileset();
  return withDelegateFallback((delegate) =>
    ImageSegmenter.createFromOptions(files, {
      baseOptions: { modelAssetPath: SEG_MODEL, delegate },
      runningMode: "VIDEO",
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    }));
}

export async function openCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}
