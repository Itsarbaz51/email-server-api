import express from "express";
import {
  createContactMessage,
  createTestimonial,
  getAllContactMessage,
  getAllTestimonial,
} from "../controllers/home.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/home-contact", createContactMessage);
router.post("/new-testimonial", createTestimonial);
router.get("/all-contacts", requireAuth, getAllContactMessage);
router.get("/all-testimonials", requireAuth, getAllTestimonial);

export default router;
