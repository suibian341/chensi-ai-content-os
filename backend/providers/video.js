import { renderRemoteVideo } from './remote-video.js';
import { renderImsVideo } from './remote-video-ims.js';
import { getProviderConfig } from './config.js';

/**
 * Which engine renders the video.
 *
 * Both backends run the *same* editing algorithm: `remote-video.js` asks the
 * private render service to decide and encode locally, while `remote-video-ims.js`
 * asks it to decide only and hands the compiled Timeline to Aliyun IMS for the
 * encode. Switching `IP_AGENT_VIDEO_RENDER_BACKEND` therefore changes where the
 * compute happens, not what the edit looks like.
 */
export async function renderVideo(task, input, project, options = {}) {
  const config = getProviderConfig().videoRenderService;
  if (config.backend !== 'ims') return renderRemoteVideo(task, input, project, options);

  const template = String(input?.template || 'vlog').trim() || 'vlog';
  if (template !== 'vlog') {
    // The IMS executor only runs compiled Vlog timelines. Talking-head keeps its
    // existing pipeline rather than being half-supported on the cloud path.
    await options?.onProgress?.(6, 'IMS 只执行 Vlog 时间线，改用原智能剪辑服务');
    const result = await renderRemoteVideo(task, input, project, options);
    result.fallbackFrom = 'aliyun-ims';
    result.fallbackReason = 'IMS_TEMPLATE_UNSUPPORTED';
    return result;
  }

  try {
    return await renderImsVideo(task, input, project, options);
  } catch (error) {
    // Re-running the whole job on the private box is safe only because both
    // paths execute the same algorithm: the fallback cannot change the edit.
    if (!config.fallbackLocal) throw error;
    await options?.onProgress?.(6, 'IMS 不可用，回退到原智能剪辑服务');
    const result = await renderRemoteVideo(task, input, project, options);
    result.fallbackFrom = 'aliyun-ims';
    result.fallbackReason = error?.code || error?.message || 'IMS_FAILED';
    return result;
  }
}
