import Prisma from "../db/db.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const createTestimonial = asyncHandler(async (req, res) => {
  const { name, designation, company, review, rating } = req.body;

  if (!name || !designation || !company || !review || !rating) {
    return ApiError.send(res, 400, "All fields are required.");
  }

  const newTestimonial = await Prisma.testimonial.create({
    data: {
      name,
      designation,
      company,
      review,
      rating: parseInt(rating),
    },
  });

  return res
    .status(201)
    .json(
      new ApiResponse(201, "Testimonial submitted successfully", newTestimonial)
    );
});

export const createContactMessage = asyncHandler(async (req, res) => {
  const { name, email, phone, subject, message } = req.body;

  if (!name || !email || !subject || !message) {
    return ApiError.send(
      res,
      400,
      "Name, email, subject, and message are required."
    );
  }

  const newContact = await Prisma.contact.create({
    data: {
      name,
      email,
      phone: phone || null,
      subject,
      message,
    },
  });

  return res
    .status(201)
    .json(
      new ApiResponse(201, "Contact message submitted successfully", newContact)
    );
});
