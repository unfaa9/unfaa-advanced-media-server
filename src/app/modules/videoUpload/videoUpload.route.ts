import express, { NextFunction } from 'express';
import uploadVideo, { uploadVideoMulter } from '../../middlewares/uploadVideo';
import { videoUploadController } from './videoUpload.controller';

const router = express.Router();
router.post(
  '/',
  uploadVideoMulter.single('video'),
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: NextFunction
  ) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        message: 'You cannot upload files larger than 40MB',
      });
    }
    if (err) return next(err); // other errors
    next();
  },
  uploadVideo,
  videoUploadController.uploadSingleFile
);
router.delete('/delete-videos', videoUploadController.deleteVideos);
export const videoUploadRoutes = router;
