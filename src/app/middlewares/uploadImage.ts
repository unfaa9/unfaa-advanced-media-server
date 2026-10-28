import { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import httpStatus from 'http-status';
import multer from 'multer';
import path from 'path';
import sharp from 'sharp';
import { z } from 'zod';
import ApiError from '../../errors/ApiError';

type TImageConfigQuery = {
  w?: number;
  h?: number;
  q?: number;
  format?: string;
};
export const uploadDir =
  process.env.NODE_ENV === 'production'
    ? '/mnt/data/uploads'
    : path.join(__dirname, '../../../uploads');
// cloudinary config
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const name = req.query.updateFileName as string;
    // if name exist then it must be end with .png or .jpg. jpeg or .webp
    const validExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
    if (name && !validExtensions.some(ext => name.toString().endsWith(ext))) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'File name must be end with .png, .jpg, .jpeg or .webp'
      );
    }
    const format = req.query.format;
    if (name && format) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'File name and format cannot be provided at same time!'
      );
    }
    let imgMainName = '';
    if (format) {
      const splitName = file.originalname.split('.');
      splitName.pop();
      imgMainName = `${splitName.join('.')}.${format}`;
    } else {
      imgMainName = name || file.originalname;
    }

    // check is file exist
    const isExist = fs.existsSync(`./uploads/img/${name}`);
    if (name && isExist) {
      cb(null, name.toString());
      return;
    }
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(imgMainName));
  },
});

export const uploadMulter = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new ApiError(httpStatus.BAD_REQUEST, 'Invalid file type!'));
    }
  },
  limits: {
    // 4mb
    fileSize: 4000000,
  },
});

const uploadImage = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.file) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Image file not found!');
    }

    // Extract image configuration from the query
    const imageConfig = req.query;
    const imageConfigData = {
      w: imageConfig.w ? parseInt(imageConfig.w as string) : undefined,
      h: imageConfig.h ? parseInt(imageConfig.h as string) : undefined,
      q: imageConfig.q ? parseInt(imageConfig.q as string) : undefined,
      format: imageConfig.format as 'png' | 'jpeg' | 'webp' | undefined,
      fit: imageConfig.fit as
        | 'cover'
        | 'contain'
        | 'fill'
        | 'inside'
        | 'outside'
        | undefined,
    };

    // Zod validation schema for imageConfig
    const imageConfigSchema = z.object({
      w: z.number().optional(),
      h: z.number().optional(),
      q: z.number().min(1).max(100).default(100),
      format: z.enum(['png', 'jpeg', 'webp']).optional(),
      fit: z.enum(['cover', 'contain', 'fill', 'inside', 'outside']).optional(),
    });

    // Validate the configuration against the schema
    const parsedImageConfig = imageConfigSchema.parse(imageConfigData);

    const file = req.file;
    console.log(file);

    // Original file path
    const filePath = path.join(file.destination, file.filename);
    // Temporary file path for optimized image
    const tempFilePath = path.join(file.destination, `temp-${file.filename}`);

    // Initialize the sharp instance
    let sharpInstance = sharp(filePath);

    // Apply resizing if width and/or height are specified
    if (parsedImageConfig.w || parsedImageConfig.h) {
      sharpInstance = sharpInstance.resize(
        parsedImageConfig.w,
        parsedImageConfig.h,
        {
          fit: parsedImageConfig.fit || 'cover',
        }
      );
    }

    // Determine the target format
    const originalFormat = file.mimetype.split('/')[1] as 'png' | 'jpeg' | 'webp';
    const targetFormat = parsedImageConfig.format || originalFormat;

    // Apply the format and quality
    if (targetFormat === 'png') {
      sharpInstance = sharpInstance.png({ quality: parsedImageConfig.q });
    } else if (targetFormat === 'webp') {
      sharpInstance = sharpInstance.webp({ quality: parsedImageConfig.q });
    } else {
      sharpInstance = sharpInstance.jpeg({ quality: parsedImageConfig.q });
    }

    // Process and save the optimized image to the temporary file
    await sharpInstance.toFile(tempFilePath);

    // Rename the temporary file to the original file name
    fs.rename(tempFilePath, filePath, err => {
      if (err) {
        return next(err);
      }

      // Generate the image URL
      const imageUrl = `https://${req.get('host')}/uploads/img/${file.filename
        }`;
      console.log(imageUrl);

      // Add the image URL to the request body
      req.body.uploadedImageUrl = imageUrl;
      next();
    });
  } catch (e) {
    next(e);
  }
};

// async function uploadToCloudinary(file: UploadedFile, publicId: string) {
//   return new Promise<UploadApiResponse>((resolve, reject) => {
//     cloudinary.uploader
//       .upload(file.tempFilePath, {
//         resource_type: 'auto', // Automatically determine the resource type
//         public_id: publicId,
//       })
//       .then(result => {
//         resolve(result);
//       })
//       .catch(error => {
//         reject(error);
//       });
//   });
// }

export default uploadImage;
