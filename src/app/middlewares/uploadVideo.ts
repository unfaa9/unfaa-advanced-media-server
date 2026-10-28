import { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import httpStatus from 'http-status';
import multer from 'multer';
import path from 'path';
import ApiError from '../../errors/ApiError';

// Video uploads folder
export const videoUploadDir =
  process.env.NODE_ENV === 'production'
    ? '/mnt/data/uploads/videos'
    : path.join(__dirname, '../../../uploads/videos');

// Ensure the video directory exists
if (!fs.existsSync(videoUploadDir)) {
  fs.mkdirSync(videoUploadDir, { recursive: true });
}

// Multer storage config for videos
const videoStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!fs.existsSync(videoUploadDir)) {
      fs.mkdirSync(videoUploadDir, { recursive: true });
    }
    cb(null, videoUploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

// Video-only file filter
const videoFileFilter = (
  req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  if (file.mimetype.startsWith('video/')) {
    cb(null, true);
  } else {
    cb(new Error('Only video files are allowed!'));
  }
};

// Multer upload configuration for video
export const uploadVideoMulter = multer({
  dest: videoUploadDir,
  storage: videoStorage,
  fileFilter: videoFileFilter,
  limits: {
    fileSize: 40 * 1024 * 1024, // 2MB limit
  },
});

// Middleware to handle video upload
const uploadVideo = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.file) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Video file not found!');
    }

    const file = req.file;
    const videoUrl = `${req.protocol}://${req.get('host')}/uploads/videos/${
      file.filename
    }`;
    req.body.uploadedVideoUrl = videoUrl;

    next();
  } catch (error) {
    next(error);
  }
};

export default uploadVideo;
