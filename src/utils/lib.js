// src/utils/lib.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export const hashPassword = async (password) => {
  if (!password) throw new Error("Password is required for hashing.");
  return await bcrypt.hash(password, 10);
};

export const comparePassword = async (password, hashedPassword) => {
  if (!password || !hashedPassword) return false;
  return await bcrypt.compare(password, hashedPassword);
};

export const generateAccessToken = (id, email, role) => {
  return jwt.sign({ id, email, role }, process.env.ACCESS_TOKEN_SECRET, {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRY || "1d",
  });
};

export const generateRefreshToken = (id, email, role) => {
  return jwt.sign({ id, email, role }, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: process.env.REFRESH_TOKEN_EXPIRY,
  });
};

export function generateInvoiceId() {
  const year = new Date().getFullYear()
  const random = Math.floor(1000 + Math.random() * 9000) // 4 digit
  return `INV-${year}-${random}`
}
