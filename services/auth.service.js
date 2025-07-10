const User = require("../models//user");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const signup = async ({ name, email, password }) => {
  const existingUser = await User.findOne({ email });
  if (existingUser) throw new Error("User already exists");

  const user = new User({ name, email, password });
  await user.save();
  return { message: "Signup successful" };
};

const login = async ({ email, password }) => {
  const user = await User.findOne({ email });
  if (!user) throw new Error("User not found");

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw new Error("Invalid credentials");

  const token = jwt.sign(
    { id: user._id, email: user.email },
    process.env.JWT_SECRET,
    {
      expiresIn: "1Y",
    }
  );

  return { token, id: user._id, email: user.email, name: user.name };
};

module.exports = { signup, login };
