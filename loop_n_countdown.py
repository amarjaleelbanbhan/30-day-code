n = int(input("Enter a positive integer: "))
if n >= 1:
    countdown = n
    while countdown >= 1:
        print(countdown)
        countdown -= 1
else:
    print("please enter a positive integer.")
print("🎉 Blast Off!")