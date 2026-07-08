import { Request, Response, NextFunction } from "express";
import { ZodError, ZodSchema, ZodIssue } from "zod";

export const validateSchema = (schema: ZodSchema) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (req.method === "GET") {
                req.query = await schema.parseAsync(req.query) as any;
            } else {
                req.body = await schema.parseAsync(req.body);
            }
            return next();
        } catch (error) {
            if (error instanceof ZodError) {
                return res.status(400).json({
                    code: 400,
                    status: "error",
                    message: "Validation failed",
                    errors: error.issues.map((err: ZodIssue) => ({
                        field: err.path.join("."),
                        message: err.message,
                    })),
                });
            }
            return res.status(500).json({
                code: 500,
                status: "error",
                message: "Internal validation error",
            });
        }
    };
};
