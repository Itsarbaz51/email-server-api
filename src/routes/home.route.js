import express from "express";
import {
  createContactMessage,
  createTestimonial,
  getAllContactMessage,
  getAllTestimonial,
} from "../controllers/home.controller.js";

const router = express.Router();

router.post("/home-contact", createContactMessage);
router.post("/new-testimonial", createTestimonial);
router.get("/all-contacts", getAllContactMessage);
router.get("/all-testimonials", getAllTestimonial);

export default router;
