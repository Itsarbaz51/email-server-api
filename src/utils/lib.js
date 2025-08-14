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
  const secret = process.env.ACCESS_TOKEN_SECRET;
  const expiresIn = process.env.ACCESS_TOKEN_EXPIRY || "7d";
  return jwt.sign({ id, email, role }, secret, { expiresIn:expiresIn });
};

export const generateRefreshToken = (id, email, role) => {
  const secret = process.env.REFRESH_TOKEN_SECRET;
  const expiresIn = process.env.REFRESH_TOKEN_EXPIRY || "90d";
  return jwt.sign({ id, email, role }, secret, { expiresIn:expiresIn });
};
