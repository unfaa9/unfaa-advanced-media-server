import { Request, RequestHandler, Response } from 'express';
import fs from 'fs';
import httpStatus from 'http-status';
import catchAsync from '../../../shared/catchAsync';
import sendResponse from '../../../shared/sendResponse';
// import { fileUpload } from 'express-fileupload';

const uploadSingleFile: RequestHandler = catchAsync(
  async (req: Request, res: Response) => {
    const data = req.body;
    sendResponse<{ url: string }>(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: 'Image uploaded successfully!',
      data: { url: data.uploadedImageUrl },
    });
  }
);
const getAllFiles: RequestHandler = catchAsync(
  async (req: Request, res: Response) => {
    const files = fs.readdirSync('uploads/img');
    const urls = files.map(
      file => `${req.protocol}://${req.get('host')}/uploads/img/${file}`
    );
    sendResponse<{ urls: string[] }>(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: 'All files fetched successfully!',
      data: { urls: urls },
    });
  }
);
type TDeleteFile = {
  urls: string[];
};
type TDeleteInfo = {
  url: string;
  deleted: boolean;
  message: string;
};
const deleteFile: RequestHandler = catchAsync(
  async (req: Request, res: Response) => {
    const data = req.body as TDeleteFile;
    console.log(data);
    const deleteInfo = [] as TDeleteInfo[];
    data.urls.map(url => {
      const fileName = url.split('/').pop();
      // check is file exist
      if (!fs.existsSync(`uploads/${fileName}`)) {
        deleteInfo.push({
          url,
          deleted: false,
          message: 'File not found to delete',
        });
        return;
      }
      fs.unlinkSync(`uploads/${fileName}`);
      deleteInfo.push({
        url,
        deleted: true,
        message: 'File deleted successfully',
      });
    });

    sendResponse<{
      deleteInfo: TDeleteInfo[];
    }>(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: 'User Created successfully!',
      data: { deleteInfo: deleteInfo },
    });
  }
);
export const fileUploadController = {
  uploadSingleFile,
  deleteFile,
  getAllFiles,
};
