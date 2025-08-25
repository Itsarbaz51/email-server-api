import express from "express";
import {
  createContactMessage,
  createTestimonial,
} from "../controllers/home.controller.js";

const router = express.Router();

router.post("/home-contact", createContactMessage);
router.post("/new-testimonial", createTestimonial);

export default router;
