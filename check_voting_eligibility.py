# File: check_voting_eligibility.py

name = input("Enter your name: ")
age = int(input("Enter your age:"))
if age >= 18:
    print(f"✅ {name}, your eligible to vote.")
else:
    print(f"❌ Sorry {name}, you are not eligible to vote yet.")
