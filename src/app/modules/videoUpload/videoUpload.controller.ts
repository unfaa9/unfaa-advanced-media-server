import { Request, RequestHandler, Response } from 'express';
import httpStatus from 'http-status';
import path from 'path';
import catchAsync from '../../../shared/catchAsync';
import sendResponse from '../../../shared/sendResponse';
import { videoUploadDir } from '../../middlewares/uploadVideo';
// import { fileUpload } from 'express-fileupload';
import fs from 'fs';
const uploadSingleFile: RequestHandler = catchAsync(
  async (req: Request, res: Response) => {
    sendResponse<{ url: string }>(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: 'Video uploaded successfully!',
      data: { url: req.body.uploadedVideoUrl },
    });
  }
);

const deleteVideos = catchAsync((req: Request, res: Response) => {
  const { videoUrls } = req.body;

  if (!Array.isArray(videoUrls) || videoUrls.length === 0) {
    return res.status(httpStatus.BAD_REQUEST).json({
      message: 'No video URLs provided.',
    });
  }

  const basePath = videoUploadDir;

  const failed: string[] = [];
  const deleted: string[] = [];

  videoUrls.forEach(url => {
    try {
      const fileName = path.basename(url); // extract filename from URL
      const fullPath = path.join(basePath, fileName);

      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        deleted.push(fileName);
      } else {
        failed.push(fileName);
      }
    } catch (err) {
      failed.push(url);
    }
  });

  return res.status(httpStatus.OK).json({
    message: 'Video deletion complete.',
    deleted,
    failed,
  });
});

export const videoUploadController = {
  uploadSingleFile,
  deleteVideos,
};
